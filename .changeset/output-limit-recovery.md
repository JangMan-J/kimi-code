---
"@moonshot-ai/kimi-code": minor
---

Retry responses cut off by the output token limit while the model is still reasoning with a reminder, up to three times; when the reminders run out the turn now ends as truncated instead of failing with an empty-response error.
