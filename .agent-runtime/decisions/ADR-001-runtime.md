# ADR-001: Minimal native Codex runtime

## Context

The PRD requires real independent contexts, persistent ownership/evidence and recovery without turning orchestration into a second product.

## Decision

Use native Codex subagents for isolated contexts, Git worktrees only for parallel writers, and `.agent-runtime/state.json` as the single persistent task authority. JSONL events and concise checkpoints are audit snapshots.

## Alternatives

A custom multi-process scheduler was rejected because native subagent primitives are available.

## Consequences

The Lead owns integration and production. Review contexts remain distinct from critical implementers.

## Evidence

Three independent read-only PRD audit contexts were spawned during bootstrap; write/review isolation is exercised before implementation integration.

