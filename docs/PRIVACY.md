# Privacy

- Room topics, complete agent profiles, messages, and runs are stored in browser IndexedDB on the current device.
- The necessary transcript is sent transiently to Cloudflare and NVIDIA to generate each response.
- Server persistence is limited to anonymous sessions, irreversible network-risk keys, roster identifiers, scheduler cursor/fairness metadata, run counters, idempotency records, leases, cooldowns, and quota counters.
- The service does not intentionally log prompt text, topics, personas, generated content, provider payloads, authorization headers, or secrets.
- The anonymous session is not an account and is not used for cross-device sync, profiles, or marketing tracking.
- Cloudflare Turnstile appears only after server-detected risk and is always verified server-side.
- Clearing local data deletes local rooms, agents, runs, and messages; expired control metadata is removed by server TTL.

