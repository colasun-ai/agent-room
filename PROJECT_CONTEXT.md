# PROJECT_CONTEXT

- Phase: Password-gated developer beta deployment
- Release class: PRIVATE_BETA
- Protocol tag: `agentroom.v1`
- Control schema: 1
- Runtime: PASS; native Codex subagents and isolated Git worktree self-test independently reviewed
- Access: server-verified password gate; restricted to authorized developers for development/evaluation
- NVIDIA: deployment-scoped Secret installed; anonymous public inference remains out of scope
- Cloud bindings: implemented `CONTROL_PLANE` SQLite Durable Object
- Public source: `https://github.com/colasun-ai/agent-room` (`main` published)
- Last deployment: password-gated, AI-enabled PRIVATE_BETA at `https://agent-room.colasun-ai.workers.dev`, version `c2cb4438-ca8b-47d7-9eb9-8cd64d581e0d`
- Model: `meta/llama-3.1-8b-instruct`; real NVIDIA streaming and explicit cancel/immediate recovery smoke PASS
- Verification: 54 unit/integration tests, 11 Workers SQLite DO tests, 56 browser E2E tests, build, lint, typecheck, secret scan and runtime gate PASS
- Security re-review: APPROVE; zero open CRITICAL/MAJOR
- PRD/release code re-review: APPROVE; zero open CRITICAL/MAJOR
- Hosted GitHub CI: SUCCESS for release commit `56244c9`, run `32333174381`
- Next critical task: none; private-beta release complete
