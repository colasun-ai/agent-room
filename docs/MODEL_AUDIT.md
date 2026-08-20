# Model audit

Audit date: 2026-08-20. Status: **enabled for password-gated development; real account stream VERIFIED**.

| Field | Evidence |
| --- | --- |
| Provider/model ID | NVIDIA Build hosted API, `meta/llama-3.1-8b-instruct` |
| Official listing | [NVIDIA Build Llama 3.1 8B Instruct](https://build.nvidia.com/meta/llama-3_1-8b-instruct) |
| Base URL | `https://integrate.api.nvidia.com/v1` |
| Endpoint | `POST /chat/completions` |
| Modalities | Text input and text output |
| Streaming | Official page states streaming support; API reference describes data-only SSE ending with `[DONE]` |
| Context | Official model page lists 128K tokens; AgentRoom uses a much smaller server-side context budget |
| Parameters used | server-chosen model, structured messages, bounded temperature, bounded `max_tokens`, `stream: true` |
| Hidden fields | AgentRoom never forwards separate reasoning fields and never includes them in subsequent context |
| Tools | Model may support tools; AgentRoom does not send tool definitions or allow tool calls |
| Model terms | Meta Llama 3.1 Community License plus the terms linked by NVIDIA |
| Hosted service terms | Separate NVIDIA API Trial Terms; see eligibility audit |
| Real smoke | Direct NVIDIA SSE returned HTTP 200, first byte in 1.98 seconds, completed in 2.00 seconds with `[DONE]` on 2026-08-20 |

The previously selected `z-ai/glm-5.2` remained listed for this account but returned no response headers or bytes during a bounded 120-second streaming probe. The deployment therefore uses the catalog-listed Llama 3.1 8B model that passed the same account's real SSE probe. It is the single private-beta server-side default; the browser does not expose raw model selection.
