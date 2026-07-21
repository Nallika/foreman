# foreman

`foreman` is a CLI-centric task orchestration runner that executes multi-stage development plans using the **Antigravity CLI (`agy`)**. It processes a structured task queue (`tasks.json`) and a shared architectural context (`CONTEXT.md`), spawning isolated `agy` processes per task with full logging, verification, and abort-on-failure semantics.

## Architecture

```
index.ts → orchestrator.ts → runner.ts → agy (child process)
(bootstrap)   (job loop)       (process spawn)
```

### Module Map

| Module | Responsibility |
|---|---|
| `config.ts` | CLI argument parsing via `commander` (`--tasks`, `--context`, `--timeout`, `--dry-run`) |
| `validator.ts` | Pre-flight checks: git root, `package.json`, `tasks.json` schema, context file, baseline verify commands |
| `queue.ts` | `QueueManager` class: run folder creation, `state.json` lifecycle, task iteration |
| `prompt.ts` | Reads `CONTEXT.md` + task definition + verify commands → assembled agent prompt |
| `runner.ts` | Spawns `agy` via `execa`, streams stdout/stderr, enforces timeout (SIGTERM→SIGKILL), signal forwarding |
| `orchestrator.ts` | Core job loop: iterate tasks → spawn → verify → update state → abort on failure |
| `verifier.ts` | Post-task checks: exit code, git cleanliness, JSONL log scanning for ERROR/CRITICAL |
| `logger.ts` | `RunLogger`/`TaskLogger`: per-task JSONL files, pattern-based log level classification, `issues.jsonl` aggregation |
| `ui.ts` | `Dashboard` class: progress bar, ETA, colored task results, final run summary table |
| `hooks.ts` | `HookManager`: typed lifecycle events (`onRunnerStart`, `onTaskStart`, `onTaskSuccess`, `onTaskFailure`, `onRunnerComplete`) |
| `types.ts` | Shared type definitions: `Task`, `TasksFile`, `RunState`, `TaskState`, `LogEntry` |
| `utils.ts` | Shared utilities (e.g. `sanitizeTaskId`) |

## Key Design Principles

1. **Clean Process Isolation** — each task runs in a new `agy` process; no context accumulation.
2. **Abort on Failure** — failed/timed-out tasks abort the entire run to prevent cascading errors.
3. **Immutable Task Definitions** — `tasks.json` is never mutated; run state lives in per-run `state.json`.
4. **Run Isolation** — each execution produces a unique run folder (`foreman/runs/<run-id>/`) with its own logs and state.
5. **Static Context** — `CONTEXT.md` is read-only throughout the run.

## Runtime Folder Structure

```
<project-root>/
├── foreman/
│   ├── tasks.json                          # Immutable task definitions
│   └── runs/
│       └── run-<ISO-timestamp>/
│           ├── state.json                  # Per-run state (task statuses, timestamps)
│           └── logs/
│               ├── <Task-ID>.jsonl         # Per-task structured log
│               └── issues.jsonl            # Aggregated errors/criticals
```

## Task Statuses

| Status | Meaning |
|---|---|
| `pending` | Not yet started |
| `running` | Currently being processed |
| `success` | Completed and verified |
| `failed` | Failed verification or errored |
| `timeout` | Killed due to timeout |
| `aborted` | Skipped because a prior task failed |

## Dependencies

- `commander` — CLI argument parsing
- `execa` — child process management
- `chalk` — terminal styling
- `cli-progress` — progress bar rendering

## Conventions

- **Module size**: target < 150–200 lines per file
- **Imports**: ESM with `.js` extensions (`import ... from './module.js'`)
- **Logging**: structured JSONL with `{ ts, level, taskId, source, msg }` schema
- **Log levels**: `INFO`, `WARN`, `ERROR`, `CRITICAL`
- **Task IDs in filenames**: spaces replaced with hyphens (e.g. `Stage 3.4` → `Stage-3.4.jsonl`)
