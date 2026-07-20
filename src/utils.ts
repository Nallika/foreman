/**
 * Shared Utilities
 *
 * Small reusable helpers used across multiple foreman modules.
 */

// ---------------------------------------------------------------------------
// Filename Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a task ID for use as a filename.
 * e.g. "Stage 3.4" → "Stage-3.4"
 */
export function sanitizeTaskId(taskId: string): string {
  return taskId.replace(/\s+/g, '-');
}
