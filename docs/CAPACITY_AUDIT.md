# Capacity audit

Audit date: 2026-08-19. Plan assumption: Cloudflare Workers Free; added spend 0 RMB.

## Official current inputs

- Workers Free: 100,000 requests/day, 10 ms CPU per HTTP request, 128 MB memory, 50 subrequests/request, six simultaneous outgoing connections, 3 MB compressed Worker, 20,000 static assets. Daily requests reset at 00:00 UTC.
- SQLite Durable Objects are available on Free. Free allowances: 100,000 DO requests/day, 13,000 GB-s/day, 5 million rows read/day, 100,000 rows written/day, and 5 GB total stored data. Daily limits reset at 00:00 UTC; exceeding a dimension fails further operations.
- Project NVIDIA input: observed ceiling 40 upstream attempts/minute. Operating cap starts at 28 RPM and must not exceed 36 without an ADR and benchmark.

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Effective policy

```text
effectiveDailyAttemptLimit = min(
  24,000 project ceiling,
  permitted NVIDIA daily allowance,
  measured Workers request budget after >=20% reserve,
  measured DO request/duration budget after >=20% reserve,
  measured SQLite rows-read/write budget after >=20% reserve
)
```

At the code-policy ceiling of 24,000 attempts/day, average issue rate is only 16.7/minute; 28 RPM is a burst/rolling-window ceiling, not a daily throughput promise. With one inbound turn request and no DO proxy streaming, Workers requests remain below the 80,000 reserved operating budget. The control-plane implementation must stay near at most three billed DO sessions and three row writes per attempt to keep 24,000 attempts under the corresponding 80,000 reserved budgets. Session, register, control, challenge, asset, retry, and smoke traffic consumes the remainder.

If measurement exceeds either per-attempt envelope, the daily cap must be lowered automatically/configurably:

- 4 DO sessions/attempt ⇒ floor(80,000 / 4) = 20,000 attempts/day before other controls.
- 4 rows written/attempt ⇒ the same 20,000 ceiling.
- Duration ceiling is 13,000 GB-s/day; a 128 MB DO may stay billed for at most about 104,000 active seconds/day. The coordinator must finish transactions quickly and never proxy NVIDIA token streams.

The likely first Cloudflare bottleneck is DO request/row-write count, not RPM. Static assets and local-history features remain available even when generation is disabled or capped.

## Required pre-release measurement

For success, 401/429/503, queued cancel, pre-token abort, mid-stream abort, and timeout, record only non-content counts: Worker requests, DO/RPC sessions, rows read/written, subrequests, CPU, active duration, permit/lease outcome. Run 100/500/1,000 logical turns only with mocks and test fairness at 1/3/5/10 rooms. Run real NVIDIA only as a small permitted smoke. Until those deployed measurements exist, 24,000 is a code ceiling rather than a verified safe daily promise.

