---
"@moonshot-ai/kimi-code": minor
---

Add `kimi provider endpoint [com|ai]` and `kimi provider protocol [chat|responses|messages]` to switch the managed Kimi Code API endpoint and wire dialect from the shell. The endpoint switch keeps the existing login (both endpoints serve the same account) and retargets the managed search/fetch services with it; the dialect is stored as `wire_protocol` on the `managed:kimi-code` provider so every model refresh re-stamps it instead of dropping it. `chat`, `responses` (OpenAI Responses API) and `messages` (Anthropic Messages API) are all supported.

In the TUI, a bare `/provider` is now an EN/CN endpoint toggle (`/provider en|cn` sets it directly, `/provider manage` opens the provider manager), and `/wire` toggles the wire protocol with a Chat / Responses / Messages picker.
