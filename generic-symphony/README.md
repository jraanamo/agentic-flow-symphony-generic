# generic-symphony

Agent-agnostic coding orchestration service for Linear.

Continuously polls a Linear project for issues in configured active states, creates isolated per-issue workspaces, and runs a coding agent session for each issue. Implements the [Symphony Agent-Agnostic Spec](../SPEC-AGENT-AGNOSTIC.md).

## Quick start

```bash
cp .env.example .env
# Edit .env — set ANTHROPIC_API_KEY
# Edit WORKFLOW.md — set tracker.api_key and tracker.project_slug

npm install
npm run dev          # run with tsx (development)
# or
npm run build && npm start   # compile then run
```

## Configuration

All runtime behavior is defined in `WORKFLOW.md` (YAML front matter + prompt template). No separate config file is needed.

Key front matter fields:

| Field | Default | Description |
|---|---|---|
| `tracker.kind` | — | Required. `linear` |
| `tracker.api_key` | — | Linear API key (or `$VAR_NAME`) |
| `tracker.project_slug` | — | Linear project `slugId` |
| `tracker.active_states` | `[Todo, In Progress]` | States to dispatch |
| `tracker.terminal_states` | `[Done, Cancelled, …]` | States that stop/cleanup |
| `polling.interval_ms` | `30000` | Milliseconds between polls |
| `workspace.root` | `~/symphony_workspaces` | Root dir for per-issue workspaces |
| `agent.max_concurrent_agents` | `10` | Global concurrency limit |
| `agent.max_turns` | `20` | Max agent turns per worker session |
| `agent_backend.command` | `claude --dangerously-skip-permissions` | Agent subprocess command |
| `agent_backend.model` | null | Model override forwarded to agent |
| `agent_backend.api_key` | null | Provider API key (or `$VAR_NAME`) |
| `agent_backend.turn_timeout_ms` | `3600000` | Per-turn timeout |
| `agent_backend.stall_timeout_ms` | `300000` | Inactivity stall timeout |
| `server.port` | null | Enable HTTP status server on this port |

See [WORKFLOW.md](./WORKFLOW.md) for a working example.

## CLI flags

```
--workflow <path>    Path to WORKFLOW.md (default: ./WORKFLOW.md)
--port <number>      HTTP status server port (overrides server.port in WORKFLOW.md)
```

Environment variable alternative: `WORKFLOW_PATH=<path>`.

## HTTP status endpoint

When `server.port` is set (or `--port` is passed), a minimal HTTP server is started:

```
GET /status   → JSON snapshot of running sessions, retry queue, and token totals
```

Example response:

```json
{
  "running": [
    {
      "issue_id": "abc123",
      "identifier": "GS-42",
      "state": "In Progress",
      "attempt": null,
      "turn_count": 2,
      "started_at": "2026-04-29T10:00:00.000Z",
      "session_id": "sess-123"
    }
  ],
  "retrying": [],
  "agent_totals": {
    "inputTokens": 12500,
    "outputTokens": 4200,
    "totalTokens": 16700,
    "seconds_running": 320.5
  }
}
```

## Architecture

```
src/
  index.ts                  CLI entry point
  types.ts                  Domain types (Issue, ServiceConfig, LiveSession, …)
  logger.ts                 Structured JSON logger
  workflow/
    loader.ts               WORKFLOW.md parser (YAML front matter + prompt body)
    config.ts               Typed config getters + dispatch validation
  tracker/
    linear.ts               Linear GraphQL client (fetch candidates, state refresh)
  workspace/
    manager.ts              Per-issue workspace lifecycle + hooks
  agent/
    adapter.ts              IAgentAdapter interface + AgentEvent types
    claude.ts               Claude Code subprocess adapter (stream-json protocol)
    runner.ts               Multi-turn loop + prompt rendering (LiquidJS)
  orchestrator/
    orchestrator.ts         Poll loop, dispatch, retry, reconciliation, HTTP server
```

## Workspace hooks

Hooks run shell scripts in the workspace directory at lifecycle points:

| Hook | Fatal on failure | Runs when |
|---|---|---|
| `hooks.after_create` | Yes | Workspace first created |
| `hooks.before_run` | Yes | Before each agent session |
| `hooks.after_run` | No | After each agent session |
| `hooks.before_remove` | No | Before workspace deletion |

## Dynamic reload

`WORKFLOW.md` is watched for changes. On modification, config and the prompt template are reloaded without restart. Active sessions are not interrupted.

## Adding a new agent backend

1. Implement `IAgentAdapter` from `src/agent/adapter.ts`.
2. Map the backend's events to the normalized `AgentEvent` stream.
3. Instantiate and pass your adapter to `AgentRunner` in `src/index.ts`.
4. Set `agent_backend.kind` in `WORKFLOW.md` accordingly.
