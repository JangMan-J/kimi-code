---
"@moonshot-ai/kimi-code": patch
---

Add `[permission]` config switches `sensitive_file_guard` and `git_control_path_guard` (plus matching environment variables) to skip those approval prompts, and stop prompting when a search root is a directory that merely shares its name with a sensitive file.
