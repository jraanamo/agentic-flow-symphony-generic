---
tracker:
  kind: linear
  project_slug: "genericsymphony-05618f0da4ec"
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled
    - Canceled
    - Duplicate
    - Closed

polling:
  interval_ms: 30000

workspace:
  root: ~/generic-symphony-workspaces

hooks:
  after_create: |
    echo "Workspace created: $(pwd)"
    git clone git@github.com:jraanamo/agentic-flow-symphony-generic.git .
    npm ci
  after_run: |
    echo "Agent run finished in: $(pwd)"

agent:
  max_concurrent_agents: 3
  max_turns: 5

agent_backend:
  kind: subprocess
  command: claude --dangerously-skip-permissions
  model: claude-opus-4-7
  api_key: $ANTHROPIC_API_KEY
  execution_policy:
    skip_permissions: true
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are an autonomous coding agent working on Linear ticket `{{ issue.identifier }}`.

{% if attempt %}
## Continuation context

This is run #{{ attempt }} because the ticket is still in an active state.
Resume from the current workspace state — do not restart from scratch.
{% endif %}

## Issue

Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

### Description

{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Instructions

1. This is an unattended autonomous session. Never ask a human to perform actions.
2. Only stop early for a true blocker (missing required auth, secrets, or permissions that cannot be resolved in-session).
3. Final message must report completed actions and any blockers only.

Work only in the provided workspace directory. Do not modify files outside it.

## Default workflow

1. Determine the ticket's current status by reading available context.
2. Plan your approach before writing code.
3. Reproduce the issue or verify the current state before making changes.
4. Implement changes, run tests/validation if available.
5. Commit your work with a clear message.
6. Update the Linear ticket state appropriately when done.
