/**
 * Shared Type Definitions
 *
 * Types used across multiple foreman modules.
 */

// ---------------------------------------------------------------------------
// tasks.json Schema
// ---------------------------------------------------------------------------

export interface Task {
  /** Unique task identifier (e.g. "Stage 3.4") */
  id: string;
  /** Short human-readable task title */
  title: string;
  /** Detailed instructions for the agent */
  description: string;
}

export interface TasksFile {
  /** Unique identifier for this job */
  jobId: string;
  /** Human-readable project path reference (informational) */
  projectPath?: string;
  /** Shell commands for baseline pre-flight checks and agent prompt injection */
  verify: string[];
  /** Ordered array of tasks to execute sequentially */
  tasks: Task[];
}

// ---------------------------------------------------------------------------
// state.json Schema
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'aborted';

export type RunStatus = 'running' | 'success' | 'failed';

export interface TaskState {
  id: string;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  commitHash: string | null;
  error: string | null;
}

export interface RunState {
  runId: string;
  jobId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  tasks: TaskState[];
}

// ---------------------------------------------------------------------------
// Log Entry Schema
// ---------------------------------------------------------------------------

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  taskId: string;
  source: 'stdout' | 'stderr' | 'system';
  msg: string;
}
