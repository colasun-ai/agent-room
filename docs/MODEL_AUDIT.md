# Model audit

Audit date: 2026-08-19. Status: **enabled in code; real account smoke UNVERIFIED**.

| Field | Evidence |
| --- | --- |
| Provider/model ID | NVIDIA Build hosted API, `z-ai/glm-5.2` |
| Official listing | [NVIDIA Build GLM-5.2](https://build.nvidia.com/z-ai/glm-5.2) (updated 2026-07-03) |
| Base URL | `https://integrate.api.nvidia.com/v1` |
| Endpoint | `POST /chat/completions` |
| Modalities | Text input and text output |
| Streaming | Official page states streaming support; API reference describes data-only SSE ending with `[DONE]` |
| Context | Official model page lists 1,048,576 tokens; AgentRoom uses a much smaller server-side context budget |
| Parameters used | server-chosen model, structured messages, bounded temperature, bounded `max_tokens`, `stream: true` |
| Reasoning | Model supports reasoning, but AgentRoom discards separate reasoning fields and never includes them in subsequent context |
| Tools | Model may support tools; AgentRoom does not send tool definitions or allow tool calls |
| Model terms | NVIDIA Open Model Agreement plus upstream MIT information linked by NVIDIA |
| Hosted service terms | Separate NVIDIA API Trial Terms; see eligibility audit |
| Real smoke | Not run until a permitted, deployment-scoped key exists |

The originally scaffolded `meta/llama-3.3-70b-instruct` was rejected after the current NVIDIA Build page disclosed deprecation on 2026-08-25. GLM-5.2 is the single public server-side default; the browser does not expose raw model selection.

