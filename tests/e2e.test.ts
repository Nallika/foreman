/**
 * E2E Orchestrator Test
 *
 * Runs the full pipeline (queue → prompt → runner → verifier → state)
 * with a mocked runner (no agy) and mocked dashboard (no console).
 * Everything else is real: filesystem, git, logger, verifier, queue.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execa } from 'execa';

// ---------------------------------------------------------------------------
// Mocks (hoisted before other imports)
// ---------------------------------------------------------------------------

vi.mock('../src/runner.js', () => ({
  runTask: vi.fn(),
}));

vi.mock('../src/ui.js', () => {
  const noop = vi.fn();
  class MockDashboard {
    start = noop;
    taskStart = noop;
    taskSuccess = noop;
    taskFailure = noop;
    taskTimeout = noop;
    finish = noop;
  }
  return { Dashboard: MockDashboard };
});

// ---------------------------------------------------------------------------
// Imports (resolved after mocks)
// ---------------------------------------------------------------------------

import { runTask } from '../src/runner.js';
import { runJob } from '../src/orchestrator.js';
import type { TasksFile } from '../src/types.js';
import type { RunOptions, RunResult } from '../src/runner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foreman-e2e-'));
  await execa('git', ['init'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@foreman.dev'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'Foreman Test'], { cwd: dir });
  await writeFile(join(dir, 'README.md'), '# Test Project\n');
  await writeFile(join(dir, 'package.json'), '{"name":"test","version":"0.0.1"}\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-m', 'init'], { cwd: dir });
  return dir;
}

const testTasks: TasksFile = {
  jobId: 'e2e-test-job',
  verify: [],
  tasks: [
    { id: 'task-1', title: 'First Task', description: 'Create feature A' },
    { id: 'task-2', title: 'Second Task', description: 'Create feature B' },
    { id: 'task-3', title: 'Third Task', description: 'Create feature C' },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E — orchestrator pipeline', () => {
  let cwd: string;
  let contextPath: string;

  beforeEach(async () => {
    cwd = await createTempGitRepo();
    contextPath = join(cwd, 'CONTEXT.md');
    await writeFile(contextPath, '# Project Context\nTest project for E2E.\n');
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it('runs full pipeline to success with 3 tasks', async () => {
    let callCount = 0;

    vi.mocked(runTask).mockImplementation(async (options: RunOptions): Promise<RunResult> => {
      callCount++;
      // Simulate agy: create a file and commit
      await writeFile(join(options.cwd, `feature-${callCount}.ts`), `export const f${callCount} = true;\n`);
      await execa('git', ['add', '.'], { cwd: options.cwd });
      await execa('git', ['commit', '-m', `feat: feature ${callCount}`], { cwd: options.cwd });
      return { exitCode: 0, timedOut: false, signalKilled: false };
    });

    await runJob({
      config: { tasksPath: '', contextPath, timeout: 30, dryRun: false },
      tasksFile: testTasks,
      cwd,
    });

    // Runner was called 3 times
    expect(runTask).toHaveBeenCalledTimes(3);

    // Find the run directory (foreman/runs/run-*)
    const runsDir = join(cwd, 'foreman', 'runs');
    const runs = await readdir(runsDir);
    expect(runs).toHaveLength(1);

    const runDir = join(runsDir, runs[0]);
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf-8'));

    // All tasks succeeded
    expect(state.status).toBe('success');
    expect(state.finishedAt).toBeTruthy();
    expect(state.tasks).toHaveLength(3);
    expect(state.tasks.every((t: any) => t.status === 'success')).toBe(true);

    // Commit hashes recorded
    expect(state.tasks.every((t: any) => t.commitHash !== null)).toBe(true);

    // Each task has a different commit hash
    const hashes = state.tasks.map((t: any) => t.commitHash);
    expect(new Set(hashes).size).toBe(3);

    // Per-task log files exist
    const logsDir = join(runDir, 'logs');
    const logFiles = await readdir(logsDir);
    expect(logFiles).toContain('task-1.jsonl');
    expect(logFiles).toContain('task-2.jsonl');
    expect(logFiles).toContain('task-3.jsonl');
    expect(logFiles).toContain('issues.jsonl');

    // Git log shows the expected commits
    const gitLog = await execa('git', ['log', '--oneline'], { cwd });
    expect(gitLog.stdout).toContain('feature 1');
    expect(gitLog.stdout).toContain('feature 2');
    expect(gitLog.stdout).toContain('feature 3');
  });

  it('aborts remaining tasks when a task fails', async () => {
    let callCount = 0;

    vi.mocked(runTask).mockImplementation(async (options: RunOptions): Promise<RunResult> => {
      callCount++;
      if (callCount === 2) {
        // Second task: fail without committing
        return { exitCode: 1, timedOut: false, signalKilled: false };
      }
      await writeFile(join(options.cwd, `feature-${callCount}.ts`), `export {};\n`);
      await execa('git', ['add', '.'], { cwd: options.cwd });
      await execa('git', ['commit', '-m', `feat: feature ${callCount}`], { cwd: options.cwd });
      return { exitCode: 0, timedOut: false, signalKilled: false };
    });

    await runJob({
      config: { tasksPath: '', contextPath, timeout: 30, dryRun: false },
      tasksFile: testTasks,
      cwd,
    });

    // Runner was called only twice (aborted after task-2 failed)
    expect(runTask).toHaveBeenCalledTimes(2);

    const runsDir = join(cwd, 'foreman', 'runs');
    const runs = await readdir(runsDir);
    const runDir = join(runsDir, runs[0]);
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf-8'));

    // Run failed
    expect(state.status).toBe('failed');

    // task-1 success, task-2 failed, task-3 aborted
    expect(state.tasks[0].status).toBe('success');
    expect(state.tasks[1].status).toBe('failed');
    expect(state.tasks[2].status).toBe('aborted');

    // Failed task has error message
    expect(state.tasks[1].error).toBeTruthy();
  });

  it('handles timeout by aborting pipeline', async () => {
    let callCount = 0;

    vi.mocked(runTask).mockImplementation(async (options: RunOptions): Promise<RunResult> => {
      callCount++;
      if (callCount === 1) {
        // First task succeeds
        await writeFile(join(options.cwd, 'feature-1.ts'), 'export {};\n');
        await execa('git', ['add', '.'], { cwd: options.cwd });
        await execa('git', ['commit', '-m', 'feat: feature 1'], { cwd: options.cwd });
        return { exitCode: 0, timedOut: false, signalKilled: false };
      }
      // Second task times out
      return { exitCode: null, timedOut: true, signalKilled: false };
    });

    await runJob({
      config: { tasksPath: '', contextPath, timeout: 30, dryRun: false },
      tasksFile: testTasks,
      cwd,
    });

    const runsDir = join(cwd, 'foreman', 'runs');
    const runs = await readdir(runsDir);
    const runDir = join(runsDir, runs[0]);
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf-8'));

    expect(state.status).toBe('failed');
    expect(state.tasks[0].status).toBe('success');
    expect(state.tasks[1].status).toBe('timeout');
    expect(state.tasks[2].status).toBe('aborted');
  });

  it('completes dry-run without invoking runner', async () => {
    await runJob({
      config: { tasksPath: '', contextPath, timeout: 30, dryRun: true },
      tasksFile: testTasks,
      cwd,
    });

    // Runner should never be called in dry-run mode
    expect(runTask).not.toHaveBeenCalled();

    const runsDir = join(cwd, 'foreman', 'runs');
    const runs = await readdir(runsDir);
    const runDir = join(runsDir, runs[0]);
    const state = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf-8'));

    // All tasks marked success (dry-run skips execution)
    expect(state.status).toBe('success');
    expect(state.tasks.every((t: any) => t.status === 'success')).toBe(true);
  });
});
