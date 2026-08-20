# AgentRoom

Create agents. Put them in a room. Watch them talk.

AgentRoom is an open-source, text-only multi-agent group chat for real AI discussions. Give 2–6 agents distinct roles, start a 6/12/20-turn run, and watch a server-controlled round-robin scheduler decide who speaks next. No sign-up and no visitor API key.

> **PRIVATE_BETA · Authorized developers only.** The deployed app is protected by a server-verified password gate. NVIDIA inference is enabled only for restricted development and evaluation; it is not an anonymous public service. See [hosted API eligibility](docs/HOSTED_API_ELIGIBILITY.md).

## What it does

- Three local templates: Startup Team, Debate, and Build Something.
- Real waiting → thinking → streaming states from normalized Worker events.
- Deterministic round robin, exact `@Agent` boosts, and starvation protection.
- Start, Pause, Resume, Stop, Retry, Skip, Keep partial, and Continue controls.
- Room topics, agent personalities, runs, and messages stay in browser IndexedDB.
- The Worker stores only anonymous-session, quota, lease, scheduler, and room-control metadata.
- The access password and NVIDIA Build key remain Cloudflare secrets and never enter the browser or repository.
- Risk-triggered Turnstile, trusted Origin checks, durable RPM/daily limits, leases, and idempotency.

No web search, tools, file upload, code execution, arbitrary system prompt, cloud history, account, plan, or billing UI is included.

## Architecture

```text
React + IndexedDB  ── structured room/turn requests ──▶  Cloudflare Worker
       ▲                                                    │
       │ normalized queued/start/content/done/error SSE     ├─▶ SQLite Durable Object
       │                                                    │   session/control/quota/lease
       └────────────────────────────────────────────────────┤
                                                            └─▶ NVIDIA Build hosted API
```

The browser owns content. The server owns security and scheduling. Every upstream request represents one real agent turn; history is serialized as explicit speaker-labelled data rather than collapsing multiple agents into an anonymous assistant role.

## Local development

Requires Node.js 22 or newer.

```bash
git clone https://github.com/colasun-ai/agent-room.git
cd agent-room
npm ci
cp .dev.vars.example .dev.vars
npm run dev
```

For deterministic local development, leave `MOCK_UPSTREAM=true`. To exercise NVIDIA locally, set `NVIDIA_API_KEY` in the ignored `.dev.vars` and remove/disable the mock flag. Never commit secrets.

## Verification

```bash
npm run check
npm run build
npm run test:e2e
npm run security:scan
npm run runtime:status
```

Mock tests cover load and failure matrices. Real NVIDIA tests are intentionally small and run only through deployed Cloudflare secrets.

## Self-deploy

1. Review [hosted API eligibility](docs/HOSTED_API_ELIGIBILITY.md) and obtain NVIDIA terms that permit your serving use case.
2. Create a Cloudflare Turnstile Managed widget for the deployment hostname.
3. Configure `ACCESS_PASSWORD`, `ACCESS_HMAC_SECRET`, `NVIDIA_API_KEY`, `SESSION_HMAC_SECRET`, `TURNSTILE_SECRET_KEY`, and optionally `SMOKE_TEST_SECRET` with `wrangler secret put`.
4. Update `PUBLIC_ORIGIN`, keep the SQLite Durable Object migration, and run `npm run deploy`.

Workers Free quotas can stop generation before NVIDIA's 28 RPM operating cap. The UI remains useful for local rooms and history when private-beta inference is busy or disabled. See [capacity audit](docs/CAPACITY_AUDIT.md).

## Privacy

Room topics, complete agent profiles, and chat history are stored only on this device in IndexedDB. To generate a reply, the necessary current text is sent transiently to the Cloudflare Worker and NVIDIA. The service persists only minimal control metadata and does not intentionally log prompts or message content. Anonymous sessions are for abuse control and shared-capacity fairness, not accounts or cross-device identity. Risky traffic may receive a Cloudflare Turnstile challenge.

## License

AgentRoom is MIT licensed. Dependency and model terms are audited separately in [LICENSE_AUDIT.md](LICENSE_AUDIT.md), [MODEL_AUDIT.md](docs/MODEL_AUDIT.md), and [HOSTED_API_ELIGIBILITY.md](docs/HOSTED_API_ELIGIBILITY.md).
