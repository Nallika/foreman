/**
 * Structured JSONL Logger
 *
 * Creates per-task log files and an aggregated issues log.
 * Classifies incoming stdout/stderr lines into structured log levels.
 */

import { createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { LogEntry, LogLevel } from './types.js';
import { sanitizeTaskId } from './utils.js';

// ---------------------------------------------------------------------------
// Pattern-Based Level Classification
// ---------------------------------------------------------------------------

interface LevelPattern {
  pattern: RegExp;
  level: LogLevel;
}

/**
 * Patterns checked against stdout lines to escalate from default INFO.
 * Order matters — first match wins.
 */
const STDOUT_PATTERNS: LevelPattern[] = [
  // Critical indicators
  { pattern: /\bSIGTERM\b/i, level: 'CRITICAL' },
  { pattern: /\bSIGKILL\b/i, level: 'CRITICAL' },
  { pattern: /\bfatal\b/i, level: 'CRITICAL' },
  { pattern: /\bpanic\b/i, level: 'CRITICAL' },
  { pattern: /\bsegmentation fault\b/i, level: 'CRITICAL' },
  { pattern: /\bout of memory\b/i, level: 'CRITICAL' },

  // Error indicators
  { pattern: /\berror\b/i, level: 'ERROR' },
  { pattern: /\bfailed\b/i, level: 'ERROR' },
  { pattern: /\bERR!\b/, level: 'ERROR' },
  { pattern: /\bTypeError\b/, level: 'ERROR' },
  { pattern: /\bReferenceError\b/, level: 'ERROR' },
  { pattern: /\bSyntaxError\b/, level: 'ERROR' },
  { pattern: /\bTS\d{4,5}:/, level: 'ERROR' },

  // Warning indicators
  { pattern: /\bwarn(ing)?\b/i, level: 'WARN' },
  { pattern: /\bdeprecated\b/i, level: 'WARN' },
];

/**
 * Classify a line's log level based on its source and content.
 */
function classifyLevel(source: 'stdout' | 'stderr', msg: string): LogLevel {
  // stderr defaults to ERROR
  if (source === 'stderr') {
    // Check if it's actually a critical pattern
    for (const { pattern, level } of STDOUT_PATTERNS) {
      if (level === 'CRITICAL' && pattern.test(msg)) {
        return 'CRITICAL';
      }
    }
    return 'ERROR';
  }

  // stdout: check patterns, default to INFO
  for (const { pattern, level } of STDOUT_PATTERNS) {
    if (pattern.test(msg)) {
      return level;
    }
  }
  return 'INFO';
}


// ---------------------------------------------------------------------------
// TaskLogger Class
// ---------------------------------------------------------------------------

/**
 * Logger instance for a single task. Manages the per-task JSONL file
 * and writes to the shared issues log on ERROR/CRITICAL.
 */
export class TaskLogger {
  private readonly taskId: string;
  private readonly taskStream: WriteStream;
  private readonly issuesStream: WriteStream;

  constructor(taskId: string, logsDir: string, issuesStream: WriteStream) {
    this.taskId = taskId;
    this.issuesStream = issuesStream;

    const filename = `${sanitizeTaskId(taskId)}.jsonl`;
    this.taskStream = createWriteStream(join(logsDir, filename), {
      flags: 'a',
      encoding: 'utf-8',
    });
  }

  /**
   * Log a line from the agy process output.
   * Automatically classifies the log level based on source and content.
   */
  log(source: 'stdout' | 'stderr', msg: string): LogEntry {
    const level = classifyLevel(source, msg);
    return this.writeEntry(level, source, msg);
  }

  /**
   * Log a system-level message (e.g. timeout, process crash).
   */
  system(level: LogLevel, msg: string): LogEntry {
    return this.writeEntry(level, 'system', msg);
  }

  /**
   * Close the per-task log stream.
   * Does NOT close the shared issues stream.
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.taskStream.end((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private writeEntry(
    level: LogLevel,
    source: 'stdout' | 'stderr' | 'system',
    msg: string,
  ): LogEntry {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      taskId: this.taskId,
      source,
      msg,
    };

    const line = JSON.stringify(entry) + '\n';
    this.taskStream.write(line);

    // Aggregate errors/criticals to issues log
    if (level === 'ERROR' || level === 'CRITICAL') {
      this.issuesStream.write(line);
    }

    return entry;
  }
}

// ---------------------------------------------------------------------------
// RunLogger — Factory for TaskLoggers
// ---------------------------------------------------------------------------

/**
 * Top-level logger for a run. Manages the shared issues.jsonl stream
 * and creates per-task loggers.
 */
export class RunLogger {
  private readonly logsDir: string;
  private readonly issuesStream: WriteStream;

  constructor(logsDir: string) {
    this.logsDir = logsDir;
    this.issuesStream = createWriteStream(join(logsDir, 'issues.jsonl'), {
      flags: 'a',
      encoding: 'utf-8',
    });
  }

  /**
   * Create a TaskLogger for a specific task.
   */
  createTaskLogger(taskId: string): TaskLogger {
    return new TaskLogger(taskId, this.logsDir, this.issuesStream);
  }

  /**
   * Close the shared issues log stream. Call after the run completes.
   */
  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.issuesStream.end((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
