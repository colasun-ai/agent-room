# Contributing

AgentRoom welcomes focused, auditable contributions.

1. Read `AGENTS.md` and the Final PRD before changing behavior.
2. Keep message bodies, topics, personalities, goals, and custom instructions out of server persistence and logs.
3. Change shared protocol types before coordinating client and Worker changes.
4. Add regression tests for scheduler, trust-boundary, streaming, cancellation, or migration changes.
5. Run `npm ci`, `npm run check`, `npm run build`, and relevant Playwright tests.
6. Never commit `.dev.vars`, API keys, cookies, prompt evidence, or raw production responses.

Security and reliability changes need review by someone other than their implementer. Production deployment remains a maintainer-only action.

