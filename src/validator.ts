/**
 * Pre-flight Validation Module
 *
 * Performs all validation checks before the task execution loop begins:
 * - Git repository verification
 * - Project file existence (package.json)
 * - tasks.json schema validation
 * - CONTEXT.md existence & readability
 * - Baseline verify command execution
 */

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { execaCommand } from 'execa';
import type { Config } from './config.js';
import type { TasksFile } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  /** Parsed tasks file (available only when valid) */
  tasksFile?: TasksFile;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Internal Checks
// ---------------------------------------------------------------------------

/**
 * Verify cwd is inside a Git repository. Returns the git root path.
 */
async function checkGitRoot(): Promise<string> {
  const { stdout } = await execaCommand('git rev-parse --show-toplevel');
  return stdout.trim();
}

/**
 * Verify package.json exists at the git root.
 */
async function checkPackageJson(gitRoot: string): Promise<void> {
  const pkgPath = join(gitRoot, 'package.json');
  await access(pkgPath, constants.R_OK);
}

/**
 * Verify the context file exists and is readable.
 */
async function checkContextFile(contextPath: string): Promise<void> {
  await access(contextPath, constants.R_OK);
}

/**
 * Parse and validate the tasks.json file.
 * Returns the parsed TasksFile on success.
 */
async function parseAndValidateTasksFile(
  tasksPath: string,
): Promise<TasksFile> {
  const raw = await readFile(tasksPath, 'utf-8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse JSON: ${tasksPath}`);
  }

  const obj = parsed as Record<string, unknown>;

  // Required field checks
  if (typeof obj.jobId !== 'string' || obj.jobId.length === 0) {
    throw new Error('tasks.json: missing or empty "jobId" field');
  }

  if (!Array.isArray(obj.verify)) {
    throw new Error('tasks.json: missing or invalid "verify" array');
  }
  for (const cmd of obj.verify) {
    if (typeof cmd !== 'string' || cmd.length === 0) {
      throw new Error('tasks.json: "verify" array contains non-string or empty entry');
    }
  }

  if (!Array.isArray(obj.tasks) || obj.tasks.length === 0) {
    throw new Error('tasks.json: missing or empty "tasks" array');
  }

  const seenIds = new Set<string>();
  for (const task of obj.tasks) {
    const t = task as Record<string, unknown>;
    if (typeof t.id !== 'string' || t.id.length === 0) {
      throw new Error('tasks.json: task missing or empty "id" field');
    }
    if (seenIds.has(t.id)) {
      throw new Error(`tasks.json: duplicate task id "${t.id}"`);
    }
    seenIds.add(t.id);

    if (typeof t.title !== 'string' || t.title.length === 0) {
      throw new Error(`tasks.json: task "${t.id}" missing or empty "title" field`);
    }
    if (typeof t.description !== 'string' || t.description.length === 0) {
      throw new Error(`tasks.json: task "${t.id}" missing or empty "description" field`);
    }
  }

  return parsed as TasksFile;
}

/**
 * Run baseline verify commands to ensure the project compiles/passes
 * before any agent tasks begin.
 */
async function runBaselineVerify(
  commands: string[],
  gitRoot: string,
): Promise<string[]> {
  const errors: string[] = [];

  for (const cmd of commands) {
    try {
      await execaCommand(cmd, { cwd: gitRoot, shell: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      errors.push(`Baseline verify failed: \`${cmd}\` — ${message}`);
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run all pre-flight validation checks.
 *
 * Returns a ValidationResult with `valid: true` and the parsed `tasksFile`
 * if all checks pass, or `valid: false` with accumulated error messages.
 */
export async function validate(config: Config): Promise<ValidationResult> {
  const errors: string[] = [];
  let gitRoot = '';
  let tasksFile: TasksFile | undefined;

  // 1. Git root check
  try {
    gitRoot = await checkGitRoot();
  } catch {
    errors.push('Not inside a Git repository. Run from a valid git project root.');
    return { valid: false, errors };
  }

  // 2. package.json check
  try {
    await checkPackageJson(gitRoot);
  } catch {
    errors.push(`package.json not found at git root: ${gitRoot}`);
  }

  // 3. Context file check
  try {
    await checkContextFile(config.contextPath);
  } catch {
    errors.push(`Context file not found or not readable: ${config.contextPath}`);
  }

  // 4. Tasks file parse & validation
  try {
    tasksFile = await parseAndValidateTasksFile(config.tasksPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(message);
  }

  // Bail early if structural checks failed — no point running verify commands
  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // 5. Baseline verify commands
  const verifyErrors = await runBaselineVerify(tasksFile!.verify, gitRoot);
  if (verifyErrors.length > 0) {
    errors.push(...verifyErrors);
    return { valid: false, errors };
  }

  return { valid: true, tasksFile, errors: [] };
}
