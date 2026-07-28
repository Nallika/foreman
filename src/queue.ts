/**
 * Task Queue & State Manager
 *
 * Reads tasks.json (never mutates it), creates per-run folders, and manages
 * the state.json lifecycle throughout the execution loop.
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { execaCommand } from 'execa';
import type { Task, TasksFile, RunState, TaskState, TaskStatus } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskStatusMeta {
  commitHash?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Queue Manager Class
// ---------------------------------------------------------------------------

export class QueueManager {
  private readonly tasksFile: TasksFile;
  private readonly runDir: string;
  private readonly statePath: string;
  readonly logsDir: string;
  readonly runId: string;
  private state: RunState;

  private constructor(
    tasksFile: TasksFile,
    baseDir: string,
    runId: string,
  ) {
    this.tasksFile = tasksFile;
    this.runId = runId;
    this.runDir = join(baseDir, 'foreman', 'runs', runId);
    this.logsDir = join(this.runDir, 'logs');
    this.statePath = join(this.runDir, 'state.json');
    this.state = {
      runId,
      jobId: tasksFile.jobId,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      tasks: tasksFile.tasks.map((t) => ({
        id: t.id,
        status: 'pending' as const,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        commitHash: null,
        error: null,
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  /**
   * Initialize a new run: create the run folder, logs directory, and
   * initial state.json with all tasks set to `pending`.
   *
   * @param tasksFile - Parsed and validated tasks file
   * @param baseDir  - Git root / project root directory
   */
  static async initRun(
    tasksFile: TasksFile,
    baseDir: string,
  ): Promise<QueueManager> {
    const runId = QueueManager.generateRunId();
    const queue = new QueueManager(tasksFile, baseDir, runId);

    // Create directories
    await mkdir(queue.logsDir, { recursive: true });

    // Write initial state
    await queue.persistState();

    return queue;
  }

  /**
   * Resume a previous run: locate its state.json, reset pending/failed tasks,
   * verify commits of successful tasks, and return the queue manager.
   */
  static async resumeRun(
    tasksFile: TasksFile,
    baseDir: string,
    runIdParam?: string | boolean,
  ): Promise<QueueManager> {
    const runsDir = join(baseDir, 'foreman', 'runs');
    let runId = typeof runIdParam === 'string' ? runIdParam : '';

    if (!runId) {
      // Find the latest run
      const entries = await readdir(runsDir, { withFileTypes: true });
      const runDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('run-'))
        .map((e) => e.name);

      if (runDirs.length === 0) {
        throw new Error('No previous runs found to continue.');
      }
      runDirs.sort((a, b) => b.localeCompare(a)); // sort descending
      runId = runDirs[0];
    }

    const queue = new QueueManager(tasksFile, baseDir, runId);
    
    // Load existing state
    const existingStateRaw = await readFile(queue.statePath, 'utf-8');
    const existingState = JSON.parse(existingStateRaw) as RunState;

    if (existingState.jobId !== tasksFile.jobId) {
      throw new Error(`Cannot continue run ${runId}: Job ID mismatch.`);
    }

    // Pre-check commits and reset incomplete tasks
    for (const task of existingState.tasks) {
      if (task.status === 'success' && task.commitHash) {
        try {
          await execaCommand(`git cat-file -e ${task.commitHash}`, { cwd: baseDir });
        } catch {
          throw new Error(`Pre-check failed: Commit ${task.commitHash} for task ${task.id} does not exist in the repository. Avoid snowball errors!`);
        }
      } else {
        // Reset non-success tasks to pending
        task.status = 'pending';
        task.startedAt = null;
        task.finishedAt = null;
        task.durationMs = null;
        task.commitHash = null;
        task.error = null;
      }
    }

    existingState.status = 'running';
    queue.state = existingState;
    await queue.persistState();

    return queue;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns the next task with status `pending`, or `null` if none remain.
   */
  getNextTask(): Task | null {
    const nextState = this.state.tasks.find((t) => t.status === 'pending');
    if (!nextState) return null;

    const task = this.tasksFile.tasks.find((t) => t.id === nextState.id);
    return task ?? null;
  }

  /**
   * Update a task's status along with timestamps and optional metadata.
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    meta?: TaskStatusMeta,
  ): Promise<void> {
    const taskState = this.findTaskState(taskId);
    const now = new Date().toISOString();

    taskState.status = status;

    if (status === 'running') {
      taskState.startedAt = now;
    }

    if (status === 'success' || status === 'failed' || status === 'timeout') {
      taskState.finishedAt = now;
      if (taskState.startedAt) {
        taskState.durationMs =
          new Date(now).getTime() - new Date(taskState.startedAt).getTime();
      }
    }

    if (meta?.commitHash) {
      taskState.commitHash = meta.commitHash;
    }

    if (meta?.error) {
      taskState.error = meta.error;
    }

    await this.persistState();
  }

  /**
   * Finalize the run: set `finishedAt` and determine overall status.
   * - `success` if all tasks succeeded
   * - `failed` if any task failed, timed out, or was aborted
   */
  async finalizeRun(): Promise<void> {
    this.state.finishedAt = new Date().toISOString();

    const allSuccess = this.state.tasks.every((t) => t.status === 'success');
    this.state.status = allSuccess ? 'success' : 'failed';

    await this.persistState();
  }

  /**
   * Get a snapshot of the current run state (read-only copy).
   */
  getState(): Readonly<RunState> {
    return structuredClone(this.state);
  }

  /**
   * Get the tasks file (for prompt building, verify commands, etc.).
   */
  getTasksFile(): Readonly<TasksFile> {
    return this.tasksFile;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private findTaskState(taskId: string): TaskState {
    const task = this.state.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task not found in state: ${taskId}`);
    }
    return task;
  }

  private async persistState(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
    await writeFile(
      this.statePath,
      JSON.stringify(this.state, null, 2) + '\n',
      'utf-8',
    );
  }

  private static generateRunId(): string {
    // Format: run-2026-07-19T13-15-00
    const now = new Date();
    const iso = now.toISOString().replace(/:/g, '-').replace(/\.\d{3}Z$/, '');
    return `run-${iso}`;
  }
}
