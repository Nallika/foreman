/**
 * Post-Task Log Verification
 *
 * Determines whether a task succeeded by checking:
 * 1. Process exit code / timeout / signal
 * 2. Git working tree cleanliness
 * 3. JSONL log scanning for ERROR/CRITICAL entries
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import type { LogEntry, LogLevel } from './types.js';
import type { RunResult } from './runner.js';
import { sanitizeTaskId } from './utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerifyResult {
  pass: boolean;
  commitHash: string | null;
  errors: VerifyError[];
}

export interface VerifyError {
  check: 'exit_code' | 'timeout' | 'signal_killed' | 'git_dirty' | 'log_errors';
  message: string;
  logEntries?: LogEntry[];
}

export interface VerifyOptions {
  taskId: string;
  logsDir: string;
  runResult: RunResult;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAILURE_LEVELS: Set<LogLevel> = new Set(['ERROR', 'CRITICAL']);

/** Read and parse a JSONL log file. Silently skips malformed lines. */
async function readJsonlFile(filePath: string): Promise<LogEntry[]> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch {
    return [];
  }

  const entries: LogEntry[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as LogEntry);
    } catch {
      // skip
    }
  }
  return entries;
}

/** Check if the git working tree is clean (no uncommitted changes). */
async function isGitClean(cwd: string): Promise<boolean> {
  try {
    const result = await execa('git', ['status', '--porcelain', '-uno'], {
      cwd,
      reject: false,
    });
    return result.exitCode === 0 && result.stdout.trim() === '';
  } catch {
    return false;
  }
}

/** Get the latest commit hash (short form). */
async function getLatestCommitHash(cwd: string): Promise<string | null> {
  try {
    const result = await execa('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      reject: false,
    });
    return result.exitCode === 0 && result.stdout.trim()
      ? result.stdout.trim()
      : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Verifier
// ---------------------------------------------------------------------------

/**
 * Verify a completed task. All checks run to provide a complete error report.
 */
export async function verifyTask(options: VerifyOptions): Promise<VerifyResult> {
  const { taskId, logsDir, runResult, cwd } = options;
  const errors: VerifyError[] = [];

  // Check 1: Timeout
  if (runResult.timedOut) {
    errors.push({ check: 'timeout', message: 'Task timed out and was killed' });
  }

  // Check 2: Signal killed
  if (runResult.signalKilled) {
    errors.push({ check: 'signal_killed', message: 'Task killed due to forwarded signal' });
  }

  // Check 3: Non-zero exit code
  if (runResult.exitCode !== null && runResult.exitCode !== 0) {
    errors.push({
      check: 'exit_code',
      message: `Process exited with non-zero code: ${runResult.exitCode}`,
    });
  }

  // Check 4: Git working tree — skip if process was killed
  if (!runResult.timedOut && !runResult.signalKilled) {
    const clean = await isGitClean(cwd);
    if (!clean) {
      try {
        await execa('git', ['add', '.'], { cwd });
        await execa('git', ['commit', '-m', `chore(foreman): auto-commit for task ${taskId}`], { cwd });
      } catch (err) {
        errors.push({
          check: 'git_dirty',
          message: 'Git working tree is not clean and auto-commit failed',
        });
      }
    }
  }

  // Check 5: Log scanning for ERROR/CRITICAL
  const logFile = join(logsDir, `${sanitizeTaskId(taskId)}.jsonl`);
  const logEntries = await readJsonlFile(logFile);
  const failureEntries = logEntries.filter((e) => FAILURE_LEVELS.has(e.level));

  if (failureEntries.length > 0) {
    errors.push({
      check: 'log_errors',
      message: `Found ${failureEntries.length} error/critical entries in task log`,
      logEntries: failureEntries,
    });
  }

  // Capture commit hash
  const commitHash = await getLatestCommitHash(cwd);

  return { pass: errors.length === 0, commitHash, errors };
}
