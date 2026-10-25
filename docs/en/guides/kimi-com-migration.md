# Pointing any coding harness at kimi.com instead of kimi.ai

A migration guide for harnesses configured against the global Kimi Code API (`*.kimi.ai`) that should use the mainland endpoint (`*.kimi.com`) instead — including the wire-protocol distinctions each harness must respect. Everything below was verified live in October 2026 against both endpoints with a real Kimi Code (OAuth plan) credential and a Moonshot platform API key; the snoop captures behind the verification live in `~/Projects/JangLabs/snoop/model-capture-logs/`.

**The one-line answer:** swap the host in every URL (`api.kimi.ai` → `api.kimi.com`, `auth.kimi.ai` → `auth.kimi.com`, keeping the `/coding/v1` path), keep the credential as-is (both endpoints accept the same tokens), and pick the wire dialect deliberately — chat completions, Responses, or Messages all work on both, and a naive host swap silently keeps whatever dialect the harness defaulted to.

## 1. Endpoint map

| Purpose | Global (kimi.ai) | Mainland (kimi.com) |
| --- | --- | --- |
| Managed API (inference) | `https://api.kimi.ai/coding/v1` | `https://api.kimi.com/coding/v1` |
| OAuth (device flow) | `https://auth.kimi.ai` | `https://auth.kimi.com` |
| Web search service | `https://api.kimi.ai/coding/v1/search` | `https://api.kimi.com/coding/v1/search` |
| Web fetch service | `https://api.kimi.ai/coding/v1/fetch` | `https://api.kimi.com/coding/v1/fetch` |
| Quota / usage | `https://api.kimi.ai/coding/v1/usages` | `https://api.kimi.com/coding/v1/usages` |
| Model catalog | `https://api.kimi.ai/coding/v1/models` | `https://api.kimi.com/coding/v1/models` |
| CDN (updates, plugins) | `https://code.kimi.ai/kimi-code` | `https://code.kimi.com/kimi-code` |
| Site (docs, console) | `https://www.kimi.ai` | `https://www.kimi.com` |
| Remote-control relay | `https://code-rc.kimi.ai` | `https://code-rc.kimi.com` |

Telemetry is the one asymmetric entry: only the mainland profile declares a collector (`https://telemetry-logs.kimi.com/v1/event`). A harness pointing at `.ai` that mirrors telemetry to a `.com` collector should be treated as optional, not required.

Path shapes are identical on both sides. `/coding/v1` is the prefix for every managed route.

## 2. Credentials — what transfers and what breaks

**Tokens are cross-accepted.** An OAuth access token issued by `auth.kimi.ai` returns `200` on `api.kimi.com` routes, and vice versa; the OAuth `client_id` is shared across regions. Verified with a live `Bearer` against `/models`, `/usages`, and all three inference routes on `.com`. A Moonshot platform API key (`sk-kimi-…`) is also accepted by `/coding/v1` on both endpoints — useful for harnesses that have no Kimi OAuth implementation at all.

**The trap: credential slot keying.** Harnesses that derive their credential storage key from the *combination* of OAuth host and API base URL (Kimi Code CLI does: `sha256({oauthHost, baseUrl})`) will look in a different slot after the host swap and report the user as logged out. The fix pattern, implemented in this fork (`siblingManagedEndpoint` in `packages/oauth/src/managed-kimi-code.ts`):

1. Key credentials on the OAuth host alone (or keep the configured slot when the only difference between configured and expected is which of the two managed endpoints is in play).
2. Treat `api.kimi.com/coding/v1` and `api.kimi.ai/coding/v1` as one trust domain — same product, same identity provider.
3. Still key strictly for any other base URL (self-hosted, staging), so the anti-mixup guarantee that motivated the hashing survives.

**Token lifetime.** OAuth access tokens are short-lived (observed expiring within ~30 minutes); a harness that stores only the access token will die quietly. Either run the refresh flow (refresh tokens work against the same host that issued them) or use a platform API key, which does not expire on that cadence.

## 3. Wire protocols — the three dialects

Both endpoints serve the same six models (`kimi-for-coding`, `kimi-for-coding-highspeed`, `k3`, `k3-256k`, `k3.1-pro`, `k3.1-pro-highspeed`) over **all three** dialects, with identical model IDs and context lengths on `.com` and `.ai` (verified via `/coding/v1/models`). The `/models` response declares **no per-model protocol**, so nothing server-side tells a harness which dialect to use — the harness's own default decides, which is how Kimi Code CLI ends up on chat completions (its `kimi` provider definition's first base protocol).

| Dialect | Route | API family | Verified |
| --- | --- | --- | --- |
| Chat completions | `POST /coding/v1/chat/completions` | OpenAI chat | 200, SSE, `k3.1-pro` |
| Responses | `POST /coding/v1/responses` | OpenAI Responses | 200, SSE, `k3.1-pro` |
| Messages | `POST /coding/v1/messages` (kimi-code sends `?beta=true`; the parameter is optional — plain `/messages` also returns 200) | Anthropic Messages | 200, SSE, `k3.1-pro` |

### Dialect distinctions that matter to a harness

**Chat completions** (`openai-completions`):
- Request: `{"model", "messages", "max_tokens", "stream"}`.
- Reasoning surfaces as `choices[0].message.reasoning_content` (a Kimi extension of the OpenAI shape — not `reasoning`).
- Usage reports `cached_tokens` plus `prompt_tokens_details` / `completion_tokens_details` (cache-aware).
- This is what any OpenAI-compatible harness gets by default.

**Responses** (`openai-responses`) — preferred dialect for this endpoint:
- Request: `{"model", "input", "max_output_tokens", "stream"}`; effort control via `reasoning: { effort: "low" | "high" | "max" }`.
- Streaming emits real Responses-API events (`event: response.created`, typed `data` frames with `sequence_number`, `status`, structured `output[]` items) rather than chat-completion deltas.
- Reasoning arrives as a structured `{"type": "reasoning", …}` output item, not a message field.
- A harness already speaking OpenAI Responses (for OpenAI models) needs only the host swap.

**Messages** (`anthropic`):
- Request: `{"model", "messages", "max_tokens"}`; thinking control follows the Anthropic thinking-block convention.
- Responses embed `thinking` content blocks (with a `signature`) before the text block.
- Kimi Code CLI routes this dialect through the *beta* Messages API (`client.beta.messages.create`, `betaApi: true`) and sets `adaptiveThinking` — a harness claiming Anthropic compatibility should mirror the beta path if it relies on adaptive thinking.
- Its `/messages` route is the same one Anthropic-compatible harnesses (Claude Code, Cline, etc.) speak natively — no translation layer needed.

**Cross-dialect note.** A harness that lets the user choose the dialect must persist the choice in a place the model-refresh path re-stamps. In Kimi Code CLI the per-model `protocol` field is refresh-owned (upstream overwrites it every model refresh), so this fork stores the choice as `wire_protocol` on the `managed:kimi-code` provider record and stamps it onto every alias at refresh time — otherwise a hand-set dialect silently reverts to chat completions on the next refresh or login.

## 4. Identity headers

`Authorization: Bearer <token>` is the only required credential header. Kimi Code CLI additionally sends device/telemetry identity that the endpoints accept but do not require: `x-msh-platform`, `x-msh-version`, `x-msh-device-id`, `x-msh-device-model`, `x-msh-device-name`, `x-msh-os-version`. A third-party harness can omit them all (verified via bare `curl`), or send `x-msh-platform: <harness-id>` for attribution.

## 5. Harness recipes

### Kimi Code CLI (this fork)

Nothing manual — the toggles are built in:

```sh
kimi provider endpoint com     # or: ai; keeps the login, retargets search/fetch, refreshes models
kimi provider protocol responses   # chat | responses | messages; re-stamps every alias
```

TUI equivalents: bare `/provider` is the EN/CN picker (`/provider en|cn` sets directly, `/provider manage` opens the manager); `/wire` is the protocol picker. `KIMI_CODE_BASE_URL` only feeds quota/userinfo/model-list calls — chat traffic follows the provider record's `base_url`, so do not rely on the env var to reroute inference.

### Any OpenAI-compatible harness

Change the base URL and nothing else; the credential, model IDs, and request shapes carry over:

```
before: https://api.kimi.ai/coding/v1   (api type: openai-completions)
after:  https://api.kimi.com/coding/v1
```

Anthropic-compatible harnesses: point the Anthropic base URL at `https://api.kimi.com/coding/v1` and keep the Messages request shape. OpenAI-Responses harnesses: same base URL, `api: openai-responses`.

### pi coding agent

pi has no built-in Kimi provider, so add a compatible-endpoint entry in `~/.pi/agent/models.json` (see pi's *Custom Providers* / *models.json* docs). The coding endpoint accepts the Moonshot platform API key, so no OAuth extension is needed:

```json
{
  "providers": {
    "kimi": {
      "name": "Kimi (kimi.com)",
      "baseUrl": "https://api.kimi.com/coding/v1",
      "api": "openai-responses",
      "apiKey": "$KIMI_MOONSHOT_API_KEY",
      "models": [
        {
          "type": "chat",
          "id": "k3.1-pro",
          "name": "Kimi K3.1 Pro",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        },
        {
          "type": "chat",
          "id": "kimi-for-coding",
          "name": "Kimi for Coding",
          "reasoning": true,
          "input": ["text", "image"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 1048576,
          "maxTokens": 65536
        }
      ]
    }
  }
}
```

Notes:

- `api` selects the dialect: `"openai-responses"` (recommended — the endpoint's Responses dialect), `"openai-completions"` (chat completions), or `"anthropic"` (Messages). All three were verified working against `.com`.
- `apiKey: "$KIMI_MOONSHOT_API_KEY"` uses pi's env interpolation; the `sk-kimi-…` platform key is accepted by `/coding/v1` on both endpoints.
- The OAuth plan token also works as a Bearer key, but it expires within ~30 minutes — for pi prefer the platform key, or wrap `apiKey` in a `!command` that fetches a fresh token.
- Discover the live catalog for the `models` array with `curl -H "Authorization: Bearer $KIMI_MOONSHOT_API_KEY" https://api.kimi.com/coding/v1/models`.

## 6. Verification recipe

After migrating any harness, confirm each leg (all should be `200`):

```sh
BASE=https://api.kimi.com/coding/v1
KEY=<oauth-or-platform-key>

curl -s "$BASE/models" -H "Authorization: Bearer $KEY" | head -c 200
# → same six models as api.kimi.ai

curl -s "$BASE/usages" -H "Authorization: Bearer $KEY" | head -c 200
# → quota windows + booster wallet; confirms plan billing follows the token

curl -s -X POST "$BASE/responses" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"k3.1-pro","input":"say ok","max_output_tokens":16}' | head -c 200
# → resp_… object with structured output items
```

A `401 invalid_authentication_error` with a token that just worked on `.ai` means the access token expired (see §2), not that the endpoints reject each other's credentials. To watch which host a harness actually dials (rather than what its config claims), route it through snoop with a `~/.snoop/providers/kimi.json` descriptor matching `api.kimi.com` / `api.kimi.ai` and `/coding/v1/*` — the capture records `target_url` per exchange.
