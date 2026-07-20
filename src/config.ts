/**
 * CLI Configuration Module
 *
 * Parses CLI arguments using `commander` and exports a typed Config object
 * consumed by all other modules.
 */

import { Command, InvalidArgumentError } from 'commander';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Config {
  /** Absolute path to tasks.json */
  tasksPath: string;
  /** Absolute path to CONTEXT.md */
  contextPath: string;
  /** Max seconds per task before kill (default: 600) */
  timeout: number;
  /** Validate everything, print prompts, skip spawning agy */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePositiveInt(value: string): number {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('Must be a positive integer.');
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse process.argv and return a validated Config object.
 *
 * Calls `process.exit(1)` via commander on missing required args or
 * validation failures.
 */
export function parseConfig(argv: string[] = process.argv): Config {
  const program = new Command();

  program
    .name('foreman')
    .description('Automated task orchestrator for agy CLI')
    .version('0.1.0')
    .requiredOption(
      '-t, --tasks <path>',
      'Path to tasks.json',
    )
    .requiredOption(
      '-c, --context <path>',
      'Path to CONTEXT.md',
    )
    .option(
      '--timeout <seconds>',
      'Max seconds per task before kill',
      parsePositiveInt,
      600,
    )
    .option(
      '--dry-run',
      'Validate everything, print prompts, skip spawning agy',
      false,
    );

  program.parse(argv);

  const opts = program.opts<{
    tasks: string;
    context: string;
    timeout: number;
    dryRun: boolean;
  }>();

  return {
    tasksPath: resolve(opts.tasks),
    contextPath: resolve(opts.context),
    timeout: opts.timeout,
    dryRun: opts.dryRun,
  };
}
