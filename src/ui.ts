/**
 * Terminal Dashboard & Progress Display
 *
 * Renders a live terminal dashboard with progress bar, ETA, current task
 * info, and recent log lines. Prints task and run summaries on completion.
 */

import chalk from 'chalk';
import { SingleBar, Presets } from 'cli-progress';
import type { RunState, TaskState, LogEntry } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DashboardConfig {
  jobId: string;
  runId: string;
  totalTasks: number;
  logsDir: string;
}

export interface TaskInfo {
  id: string;
  title: string;
  index: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max recent log lines to display in the dashboard */
const MAX_LOG_TAIL = 3;

/** Box drawing chars */
const LINE = '─';
const SEPARATOR = LINE.repeat(65);

// ---------------------------------------------------------------------------
// Dashboard Class
// ---------------------------------------------------------------------------

export class Dashboard {
  private readonly config: DashboardConfig;
  private progressBar: SingleBar | null = null;
  private completedTasks = 0;
  private currentTask: TaskInfo | null = null;
  private taskStartTime: number = 0;
  private recentLines: string[] = [];
  private etaTracker: number[] = [];

  constructor(config: DashboardConfig) {
    this.config = config;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Print the run header and initialize the progress bar. */
  start(completedSoFar: number = 0): void {
    console.log();
    console.log(
      chalk.bold.cyan(' 🚀 foreman v0.1.0') +
      chalk.dim(` | Job: ${this.config.jobId} | Run: ${this.config.runId}`),
    );
    console.log(chalk.dim(` ${SEPARATOR}`));

    this.progressBar = new SingleBar(
      {
        format:
          chalk.cyan(' Progress: ') +
          chalk.cyan('{bar}') +
          chalk.dim(' {percentage}% ({value}/{total} Tasks)') +
          chalk.dim(' | ETA: {eta_formatted}'),
        hideCursor: true,
        clearOnComplete: false,
        etaBuffer: 5,
      },
      Presets.shades_classic,
    );
    this.completedTasks = completedSoFar;
    this.progressBar.start(this.config.totalTasks, this.completedTasks, { eta_formatted: '~calculating' });
  }

  /** Notify the dashboard that a task is starting. */
  taskStart(task: TaskInfo): void {
    this.currentTask = task;
    this.taskStartTime = Date.now();
    this.recentLines = [];
  }

  /**
   * Feed a log entry to the dashboard for live tail display.
   * Returns the entry unchanged (pass-through for stream wiring).
   */
  onLogEntry(entry: LogEntry): LogEntry {
    const styled = this.styleLogLine(entry);
    this.recentLines.push(styled);
    if (this.recentLines.length > MAX_LOG_TAIL) {
      this.recentLines.shift();
    }
    return entry;
  }

  /** Notify the dashboard that a task completed successfully. */
  taskSuccess(taskId: string, durationMs: number, commitHash: string | null): void {
    this.completedTasks++;
    this.etaTracker.push(durationMs);
    this.progressBar?.update(this.completedTasks, {
      eta_formatted: this.formatEta(),
    });

    console.log(
      chalk.green(`  ✅ [${taskId}]`) +
      chalk.dim(` completed in ${this.formatDuration(durationMs)}`) +
      (commitHash ? chalk.dim(` (${commitHash})`) : ''),
    );
  }

  /** Notify the dashboard that a task failed. */
  taskFailure(taskId: string, durationMs: number, errorMsg: string): void {
    this.completedTasks++;
    this.progressBar?.update(this.completedTasks);

    console.log(chalk.red(`  ❌ [${taskId}]`) + chalk.dim(` failed after ${this.formatDuration(durationMs)}`));
    console.log(chalk.red(`     ${errorMsg}`));
  }

  /** Notify the dashboard that a task timed out. */
  taskTimeout(taskId: string, timeoutSec: number): void {
    this.completedTasks++;
    this.progressBar?.update(this.completedTasks);

    console.log(chalk.yellow(`  ⏱  [${taskId}]`) + chalk.dim(` timed out after ${timeoutSec}s`));
  }

  /** Print final run summary and stop the progress bar. */
  finish(state: Readonly<RunState>): void {
    this.progressBar?.stop();
    console.log();
    console.log(chalk.dim(` ${SEPARATOR}`));
    console.log(chalk.bold(' 📋 Run Summary'));
    console.log(chalk.dim(` ${SEPARATOR}`));

    // Task table
    const colId = 14;
    const colStatus = 10;
    const colDuration = 12;
    const colCommit = 10;

    console.log(
      chalk.dim(
        `  ${'Task'.padEnd(colId)}${'Status'.padEnd(colStatus)}${'Duration'.padEnd(colDuration)}${'Commit'.padEnd(colCommit)}`,
      ),
    );
    console.log(chalk.dim(`  ${LINE.repeat(colId + colStatus + colDuration + colCommit)}`));

    for (const task of state.tasks) {
      const status = this.colorStatus(task.status);
      const duration = task.durationMs != null ? this.formatDuration(task.durationMs) : '—';
      const commit = task.commitHash ?? '—';

      console.log(
        `  ${task.id.padEnd(colId)}${status.padEnd(colStatus + this.ansiPadding(status))}${duration.padEnd(colDuration)}${commit.padEnd(colCommit)}`,
      );
    }

    console.log(chalk.dim(`  ${LINE.repeat(colId + colStatus + colDuration + colCommit)}`));

    // Overall result
    const runStatus = state.status === 'success'
      ? chalk.bold.green('SUCCESS')
      : chalk.bold.red('FAILED');

    let totalDuration = 0;
    for (const task of state.tasks) {
      if (task.durationMs != null) {
        totalDuration += task.durationMs;
      }
    }

    console.log(
      `\n  Result: ${runStatus}` +
      (totalDuration != null ? chalk.dim(` | Total: ${this.formatDuration(totalDuration)}`) : ''),
    );
    console.log(chalk.dim(`  Run ID: ${state.runId}`));
    console.log();
  }

  // -------------------------------------------------------------------------
  // Formatting Helpers
  // -------------------------------------------------------------------------

  private styleLogLine(entry: LogEntry): string {
    const prefix = chalk.dim(' › agy: ');
    switch (entry.level) {
      case 'CRITICAL':
        return prefix + chalk.bold.red(entry.msg);
      case 'ERROR':
        return prefix + chalk.red(entry.msg);
      case 'WARN':
        return prefix + chalk.yellow(entry.msg);
      default:
        return prefix + chalk.dim(entry.msg);
    }
  }

  private colorStatus(status: string): string {
    switch (status) {
      case 'success': return chalk.green(status);
      case 'failed':  return chalk.red(status);
      case 'timeout': return chalk.yellow(status);
      case 'aborted': return chalk.gray(status);
      case 'running': return chalk.cyan(status);
      default:        return chalk.dim(status);
    }
  }

  /** Calculate extra padding needed for ANSI escape sequences in colored strings. */
  private ansiPadding(str: string): number {
    // eslint-disable-next-line no-control-regex
    const ansiLen = str.replace(/\x1b\[[0-9;]*m/g, '').length;
    return str.length - ansiLen;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min === 0) return `${sec}s`;
    return `${min}m ${sec.toString().padStart(2, '0')}s`;
  }

  private formatEta(): string {
    if (this.etaTracker.length === 0) return '~calculating';
    const avgMs = this.etaTracker.reduce((a, b) => a + b, 0) / this.etaTracker.length;
    const remaining = this.config.totalTasks - this.completedTasks;
    const etaMs = avgMs * remaining;
    return `~${this.formatDuration(etaMs)}`;
  }
}
