/**
 * Job Orchestrator — Core Execution Loop
 *
 * Iterates the task queue, spawning an isolated agy process per task,
 * verifying results, and aborting on failure. Coordinates all modules:
 * queue, runner, verifier, logger, dashboard, and hooks.
 *
 * See docs/automation_flow.md Section 11 for the full execution flow.
 */

import type { Config } from './config.js';
import type { TasksFile } from './types.js';
import { QueueManager } from './queue.js';
import { RunLogger } from './logger.js';
import { buildPrompt } from './prompt.js';
import { runTask } from './runner.js';
import { verifyTask } from './verifier.js';
import { Dashboard } from './ui.js';
import { HookManager } from './hooks.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JobContext {
  config: Config;
  tasksFile: TasksFile;
  cwd: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full job: init run state, iterate tasks, spawn/verify/abort,
 * finalize, and print summary.
 */
export async function runJob(ctx: JobContext): Promise<void> {
  const { config, tasksFile, cwd } = ctx;

  // Initialize or resume run
  const queue = config.continue
    ? await QueueManager.resumeRun(tasksFile, cwd, config.continue)
    : await QueueManager.initRun(tasksFile, cwd);
  const runLogger = new RunLogger(queue.logsDir);
  const hooks = new HookManager();
  const dashboard = new Dashboard({
    jobId: tasksFile.jobId,
    runId: queue.runId,
    totalTasks: tasksFile.tasks.length,
    logsDir: queue.logsDir,
  });

  const completedSoFar = queue.getState().tasks.filter(t => t.status === 'success').length;
  dashboard.start(completedSoFar);

  await hooks.fire('onRunnerStart', {
    jobId: tasksFile.jobId,
    runId: queue.runId,
    tasks: tasksFile.tasks,
  });

  // Task execution loop
  let task = queue.getNextTask();
  while (task) {
    // Mark running
    await queue.updateTaskStatus(task.id, 'running');
    const taskStartTime = Date.now();

    // Fire onTaskStart
    dashboard.taskStart({ id: task.id, title: task.title, index: 0 });
    await hooks.fire('onTaskStart', { task });

    // Build prompt
    const prompt = await buildPrompt(config.contextPath, task, tasksFile.verify, cwd);

    if (config.dryRun) {
      // Dry-run: print prompt, mark success, skip execution
      console.log(`\n  [DRY RUN] Prompt for [${task.id}] ${task.title}:`);
      console.log('  ' + '─'.repeat(60));
      console.log(prompt);
      console.log('  ' + '─'.repeat(60));

      await queue.updateTaskStatus(task.id, 'success');
      const durationMs = Date.now() - taskStartTime;
      dashboard.taskSuccess(task.id, durationMs, null);
      await hooks.fire('onTaskSuccess', { task, durationMs, commitHash: null });

      task = queue.getNextTask();
      continue;
    }

    // Spawn agy, stream logs, wait for exit/timeout
    const taskLogger = runLogger.createTaskLogger(task.id);

    const runResult = await runTask({
      prompt,
      cwd,
      timeout: config.timeout,
      logger: taskLogger,
    });

    await taskLogger.close();

    // Verify task result
    const verification = await verifyTask({
      taskId: task.id,
      logsDir: queue.logsDir,
      runResult,
      cwd,
    });

    const durationMs = Date.now() - taskStartTime;

    // Handle result
    if (runResult.timedOut) {
      await queue.updateTaskStatus(task.id, 'timeout', {
        error: 'Task timed out',
      });
      dashboard.taskTimeout(task.id, config.timeout);
      await hooks.fire('onTaskFailure', {
        task,
        error: 'Task timed out',
        durationMs,
      });

      break;
    }

    if (verification.pass) {
      await queue.updateTaskStatus(task.id, 'success', {
        commitHash: verification.commitHash ?? undefined,
      });
      dashboard.taskSuccess(task.id, durationMs, verification.commitHash);
      await hooks.fire('onTaskSuccess', {
        task,
        durationMs,
        commitHash: verification.commitHash,
      });
    } else {
      const errorMsg = verification.errors
        .map((e) => e.message)
        .join('; ');

      await queue.updateTaskStatus(task.id, 'failed', { error: errorMsg });
      dashboard.taskFailure(task.id, durationMs, errorMsg);
      await hooks.fire('onTaskFailure', { task, error: errorMsg, durationMs });

      break;
    }

    task = queue.getNextTask();
  }

  // Finalize
  await runLogger.close();
  await queue.finalizeRun();

  const finalState = queue.getState();
  await hooks.fire('onRunnerComplete', { state: finalState });
  dashboard.finish(finalState);
}
