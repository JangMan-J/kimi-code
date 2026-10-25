---
"@moonshot-ai/kimi-code": patch
---

Keep a Kimi Code login usable when the managed API base URL points at the other region's endpoint (`.com` ↔ `.ai`), so `KIMI_CODE_BASE_URL` or the `managed:kimi-code` `base_url` in `config.toml` can move inference to the other endpoint without a re-login. Previously that base URL change resolved to a sibling credential slot that held no token and the session reported the user as logged out.
