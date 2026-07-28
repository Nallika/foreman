/**
 * Runner Engine — Process Lifecycle & Timeout Guard
 *
 * Spawns an isolated `agy` process per task, streams output to the logger,
 * enforces timeout with graceful SIGTERM → SIGKILL escalation, and handles
 * signal forwarding from the parent foreman process.
 */

import { execa } from 'execa';
import { createInterface } from 'node:readline';
import type { TaskLogger } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunResult {
  /** Process exit code (null if killed by signal) */
  exitCode: number | null;
  /** Whether the process was killed due to timeout */
  timedOut: boolean;
  /** Whether the process was killed due to a forwarded signal */
  signalKilled: boolean;
}

export interface RunOptions {
  /** The assembled prompt to send to agy via stdin */
  prompt: string;
  /** Working directory for the agy process (git root) */
  cwd: string;
  /** Max seconds before timeout kill */
  timeout: number;
  /** Logger instance for this task */
  logger: TaskLogger;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Grace period after SIGTERM before SIGKILL (ms) */
const SIGKILL_GRACE_MS = 5000;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Spawn an `agy` process, stream its output to the logger, and enforce
 * timeout + signal handling.
 *
 * Returns a RunResult indicating how the process exited.
 */
export async function runTask(options: RunOptions): Promise<RunResult> {
  const { prompt, cwd, timeout, logger } = options;

  let timedOut = false;
  let signalKilled = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  // Spawn agy process — prompt via stdin
  const subprocess = execa('agy', [], {
    cwd,
    input: prompt,
    // Don't throw on non-zero exit — we handle it ourselves
    reject: false,
    // Ensure streams are available
    stdout: 'pipe',
    stderr: 'pipe',
    // Don't buffer — we stream line by line
    buffer: false,
  });

  // -----------------------------------------------------------------------
  // Stream stdout/stderr line-by-line to logger
  // -----------------------------------------------------------------------

  const streamLines = (
    stream: NodeJS.ReadableStream | null,
    source: 'stdout' | 'stderr',
  ): void => {
    if (!stream) return;

    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      logger.log(source, line);
    });
  };

  streamLines(subprocess.stdout, 'stdout');
  streamLines(subprocess.stderr, 'stderr');

  // -----------------------------------------------------------------------
  // Timeout guard
  // -----------------------------------------------------------------------

  const timeoutMs = timeout * 1000;

  timeoutTimer = setTimeout(() => {
    timedOut = true;
    logger.system('CRITICAL', `Task timed out after ${timeout}s — sending SIGTERM`);
    subprocess.kill('SIGTERM');

    // Escalate to SIGKILL after grace period
    killTimer = setTimeout(() => {
      logger.system('CRITICAL', `Process still alive after ${SIGKILL_GRACE_MS}ms grace — sending SIGKILL`);
      subprocess.kill('SIGKILL');
    }, SIGKILL_GRACE_MS);
  }, timeoutMs);

  // -----------------------------------------------------------------------
  // Signal forwarding — if foreman receives SIGINT/SIGTERM, kill child
  // -----------------------------------------------------------------------

  const signalHandler = (signal: string) => {
    signalKilled = true;
    logger.system('CRITICAL', `foreman received ${signal} — killing agy process`);
    subprocess.kill('SIGTERM');

    killTimer = setTimeout(() => {
      subprocess.kill('SIGKILL');
    }, SIGKILL_GRACE_MS);
  };

  const onSigint = () => signalHandler('SIGINT');
  const onSigterm = () => signalHandler('SIGTERM');

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  // -----------------------------------------------------------------------
  // Wait for process exit
  // -----------------------------------------------------------------------

  try {
    const result = await subprocess;

    // Log exit info
    if (timedOut) {
      logger.system('CRITICAL', `Process killed due to timeout (exit code: ${result.exitCode})`);
    } else if (signalKilled) {
      logger.system('CRITICAL', `Process killed due to forwarded signal (exit code: ${result.exitCode})`);
    } else {
      const level = result.exitCode === 0 ? 'INFO' : 'ERROR';
      logger.system(level, `Process exited with code ${result.exitCode}`);
    }

    return {
      exitCode: result.exitCode ?? null,
      timedOut,
      signalKilled,
    };
  } finally {
    // Clean up timers and signal handlers
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}
