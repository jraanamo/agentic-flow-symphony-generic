# agentic-flow-symphony-generic

An agent-agnostic implementation of the [Symphony](https://github.com/openai/symphony) coding-agent orchestration spec.

Symphony turns an issue tracker (Linear) into a control plane for coding agents: it polls the tracker, creates an isolated workspace per issue, and runs a coding agent session inside that workspace until the work reaches a terminal or handoff state.

## Why this fork

The original [openai/symphony](https://github.com/openai/symphony) reference implementation and its [SPEC.md](https://github.com/openai/symphony/blob/main/SPEC.md) are coupled to OpenAI's cloud models and the Codex agent runtime.

This project is an effort to generalize that contract so Symphony can run against any coding-agent backend and any LLM provider — including local models — without depending on OpenAI's cloud APIs. The generalized contract lives in [SPEC-AGENT-AGNOSTIC.md](./SPEC-AGENT-AGNOSTIC.md), which removes provider-specific assumptions and defines a pluggable agent-backend interface.

The reference implementation in [generic-symphony/](./generic-symphony) currently ships a Claude Code adapter; additional backends can be added by implementing the agent-adapter interface described in the spec.
