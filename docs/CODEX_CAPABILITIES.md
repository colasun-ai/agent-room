# Codex capability snapshot

Verified 2026-08-18 for this repository.

## Official capabilities

OpenAI's current Codex documentation states that current local releases enable subagent workflows by default, can spawn isolated agent threads from an explicit request or applicable `AGENTS.md`, surface those threads to the Lead, inherit sandbox/approval settings, and support project-scoped custom agents. It recommends read-heavy parallelism first and warns that parallel writers need careful isolation. Codex also documents Git worktrees for independent changes and `codex exec` for non-interactive execution with explicit sandboxing and resumable sessions.

Sources:

- [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [AGENTS.md](https://learn.chatgpt.com/docs/customization/agents-md)
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

## Local capability evidence

- Codex CLI: `codex-cli 0.147.0`
- Native subagent contexts: available and exercised with three independent PRD audit contexts.
- Context messaging/follow-up/interruption: available through the active native runtime.
- Git worktrees: available through Git; required for concurrent writers.
- Project guidance: root `AGENTS.md` is present.
- Skills/plugins: available in the active Codex host; this project used the official OpenAI Docs skill for this snapshot.
- Non-interactive execution: local CLI exposes `codex exec` and `codex review`.
- Resume/continuation: local CLI exposes `resume`, `fork`, and `codex exec resume`.
- Sandbox/approval: local CLI exposes read-only/workspace-write/danger-full-access plus explicit approval modes; this project uses managed workspace-write and narrow escalation.
- Browser/computer use: no generic browser automation tool is currently exposed to this thread. Playwright remains available for project-owned browser validation.
- Primary model/reasoning: high-capability primary inherited by native subagents; private reasoning is not recorded.

## Runtime choice

Use native subagents plus Git worktrees and a small persistent task/evidence layer. A custom multi-process scheduler is unnecessary in this environment.

