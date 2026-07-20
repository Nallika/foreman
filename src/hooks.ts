/**
 * Extensibility Hook System
 *
 * Typed event hooks for lifecycle events. Allows future extensions
 * (webhooks, notifications, metrics) without touching core logic.
 */

import type { Task, RunState } from './types.js';

// ---------------------------------------------------------------------------
// Hook Event Payloads
// ---------------------------------------------------------------------------

export interface RunnerStartPayload {
  jobId: string;
  runId: string;
  tasks: Task[];
}

export interface TaskStartPayload {
  task: Task;
}

export interface TaskSuccessPayload {
  task: Task;
  durationMs: number;
  commitHash: string | null;
}

export interface TaskFailurePayload {
  task: Task;
  error: string;
  durationMs: number;
}

export interface RunnerCompletePayload {
  state: Readonly<RunState>;
}

// ---------------------------------------------------------------------------
// Hook Function Types
// ---------------------------------------------------------------------------

export type HookFn<T> = (payload: T) => void | Promise<void>;

interface HookRegistry {
  onRunnerStart: HookFn<RunnerStartPayload>[];
  onTaskStart: HookFn<TaskStartPayload>[];
  onTaskSuccess: HookFn<TaskSuccessPayload>[];
  onTaskFailure: HookFn<TaskFailurePayload>[];
  onRunnerComplete: HookFn<RunnerCompletePayload>[];
}

export type HookEvent = keyof HookRegistry;

/** Maps each hook event to its payload type for type-safe on()/fire(). */
interface HookPayloadMap {
  onRunnerStart: RunnerStartPayload;
  onTaskStart: TaskStartPayload;
  onTaskSuccess: TaskSuccessPayload;
  onTaskFailure: TaskFailurePayload;
  onRunnerComplete: RunnerCompletePayload;
}

// ---------------------------------------------------------------------------
// Hook Manager
// ---------------------------------------------------------------------------

export class HookManager {
  private readonly hooks: HookRegistry = {
    onRunnerStart: [],
    onTaskStart: [],
    onTaskSuccess: [],
    onTaskFailure: [],
    onRunnerComplete: [],
  };

  /** Register a hook function for an event. */
  on<E extends HookEvent>(event: E, fn: HookFn<HookPayloadMap[E]>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.hooks[event] as any[]).push(fn);
  }

  /** Fire all registered hooks for an event. Hooks run sequentially. */
  async fire<E extends HookEvent>(event: E, payload: HookPayloadMap[E]): Promise<void> {
    for (const fn of this.hooks[event]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (fn as HookFn<any>)(payload);
    }
  }
}
