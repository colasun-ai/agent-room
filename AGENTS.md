# AgentRoom project guidance

## Mission

Build the text-only, no-sign-up AgentRoom PUBLIC_BETA defined by
`/Users/colasun/Downloads/AgentRoom_PRD_Final.docx`.

## Non-negotiables

- Browser IndexedDB is the only persistence for room topics, agent profiles and message bodies.
- The Worker persists only anonymous-session, quota, scheduler and room-control metadata.
- The server chooses every speaker deterministically. The browser never chooses the trusted speaker.
- One server-side NVIDIA model; no search, tools, arbitrary system prompts, cloud history or fake AI states.
- Preserve end-to-end abort, leases, idempotency, Origin checks, daily/RPM caps and risk-triggered Turnstile.
- Never log prompt/message content or expose secrets. Added spend is forbidden without explicit approval.

## Engineering

- Shared schemas and stream events live in `shared/` and are contract-tested.
- Browser code lives in `src/`; Worker code lives in `worker/`.
- Critical security/reliability work requires independent review.
- Parallel writers use isolated branches/worktrees and own disjoint paths.
- Only the Lead/Release owner may merge to `main`, push, or deploy production.
- Tests and evidence must be factual. Unverified external claims remain UNVERIFIED.

## User interruption

Only interrupt for an unavoidable account-holder authorization, a missing NVIDIA key, or approval for cost/commercial terms. Complete ordinary engineering autonomously.

## Definition of done

Local gates, independent security and release reviews, public GitHub, Cloudflare deployment, real NVIDIA streaming, cancellation, quota and public smoke evidence must all pass before claiming completion.

