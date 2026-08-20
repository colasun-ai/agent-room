# Private Beta Deployment Evidence — 2026-08-20

- URL: `https://agent-room.colasun-ai.workers.dev`
- Final deployment: `2026-08-20T04:39:13.781Z`, version `c2cb4438-ca8b-47d7-9eb9-8cd64d581e0d`
- Runtime config after authenticated browser login: `releaseClass=PRIVATE_BETA`, `aiEnabled=true`
- Model observed in the production SSE `start` event: `meta/llama-3.1-8b-instruct`
- Secrets: the access password, independent access-cookie HMAC key and NVIDIA API key are Cloudflare Secrets; they are absent from source, build output and Git history
- Negative production access smoke: config without cookie `401`; forged access cookie `401`; login from a wrong Origin `403`; cancel without access cookie `401`
- Real browser cancellation/recovery smoke: session `200`; room registration `200`; first stream `200` with `queued,start`; browser abort true; explicit cancel `200`; immediate second stream `200` with `queued,start,content...,done`
- Cancellation guarantees: coordinator authorization precedes local abort; cancellation atomically clears the room lease, active idempotency state and matching permit; queued/stale acquisition returns `499`; a stale finish returns `409` without advancing turn counters
- Local release gates: 54 ordinary tests, 11 SQLite Durable Object tests and 56 Playwright checks across desktop, tablet, mobile and WebKit PASS; typecheck, lint, build, runtime gate, secret scan and `git diff --check` PASS
- Independent security review: APPROVE; zero open CRITICAL/MAJOR
- Scope: authorized developers only, for development/evaluation. No anonymous public NVIDIA inference or commercial action was authorized.
