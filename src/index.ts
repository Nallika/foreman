#!/usr/bin/env node

/**
 * foreman — CLI Entry Point
 *
 * Thin bootstrap: parse config, validate, and hand off to the orchestrator.
 */

import { parseConfig } from './config.js';
import { validate } from './validator.js';
import { runJob } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function main() {
  const config = parseConfig();

  // Pre-flight validation
  const result = await validate(config);

  if (!result.valid) {
    console.error('\n❌ Pre-flight validation failed:');
    for (const err of result.errors) {
      console.error(`  • ${err}`);
    }
    process.exit(1);
  }

  // Run the job
  await runJob({
    config,
    tasksFile: result.tasksFile!,
    cwd: process.cwd(),
  });
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
