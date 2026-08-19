# AI-disabled Deployment Evidence — 2026-08-19

- Public URL: `https://agent-room.colasun-ai.workers.dev`
- Initial upload: `2026-08-19T14:38:18.332Z`, version `3a148141-0d3e-4d42-aec8-d20c18ab7a8e`
- Current secret-change deployment: `2026-08-19T14:45:55.119Z`, version `bfa82a82-08c8-4511-a029-0c94f1b4a3dc`
- Cloudflare production binding: `AI_ENABLED=false`
- Public `/api/config`: `releaseClass=PUBLIC_BETA`, `aiEnabled=false`, `capacityState=disabled`
- Homepage: HTTP 200 with CSP, HSTS, Permissions-Policy, Referrer-Policy, nosniff and frame-denial headers
- Same-origin anonymous session: HTTP 200 after fresh project-specific `SESSION_HMAC_SECRET` and `RISK_HMAC_SECRET` were installed
- GitHub CI: SUCCESS for commit `fa95eaf`, run `32261882659`
- NVIDIA public inference: NOT RUN and NOT ENABLED. Trial Terms do not permit anonymous public hosted inference, and no deployment-scoped key with explicit public-serving rights is available.
- Release status: T-400 remains RUNNING; the AI-disabled public shell is deployed, but full public AI release is `BLOCKED_EXTERNAL`.
