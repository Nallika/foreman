/**
 * Prompt Builder
 *
 * Reads the context file and assembles the agent instruction prompt
 * from a template with dynamic verify commands from tasks.json.
 */

import { readFile } from 'node:fs/promises';
import type { Task } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full prompt to pass to an `agy` process.
 *
 * @param contextPath - Absolute path to CONTEXT.md
 * @param task        - The current task definition
 * @param verify      - Array of verify commands from tasks.json
 * @returns The assembled prompt string
 */
export async function buildPrompt(
  contextPath: string,
  task: Task,
  verify: string[],
  cwd: string,
): Promise<string> {
  const contextContent = await readFile(contextPath, 'utf-8');

  const verifyList = verify.length > 0
    ? verify.map((cmd) => `   - ${cmd}`).join('\n')
    : '   - (None)';

  return `=== SYSTEM CONTEXT ===
Target Working Directory: ${cwd}
${contextContent.trim()}

=== TARGET TASK ===
${task.title}
${task.description.trim()}

=== INSTRUCTIONS ===
1. Implement all requested changes strictly in the target codebase at ${cwd}. Do NOT create or edit files in temporary scratch directories.
2. Commit your work to Git inside ${cwd} with a clear conventional commit message.
3. Run the following verification commands locally if specified and fix any errors:
${verifyList}
4. If you encountered any non-blocking issues, warnings, or technical debt, format them in a block tagged \`[ISSUES_FOUND]\` at the end of your output.
`;
}
