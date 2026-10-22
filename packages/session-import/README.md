# Session import

This Node.js package converts one external session into ordinary user and assistant messages and session-owned attachments. It has no engine, provider, CLI, or UI dependency and does not create or resume a session.

```ts
import { convertSession } from '@moonshot-ai/session-import';

const result = await convertSession({
  source: 'claude-code',
  sourcePath: '/example/source/session.jsonl',
  attachmentDirectory: '/example/kimi-session/attachments',
  contextWindow: 262144,
});

if (result.status !== 'unreliable') {
  console.log(result.status, result.historyPath, result.issues);
}
```

`source` accepts `claude-code` and `codex`. The latter supports JSONL and JSONL.zst. An optional `stateDatabasePath` enables read-only title lookup for that source. A recorded user title wins over a generated one; without either, the title is the first prompt line with a letter or digit after control wrappers, up to 120 characters. Source files are never modified. `attachmentDirectory` must be an absolute path owned by the target session. The host appends returned messages as ordinary visible messages through its existing context API and owns session creation, persistence, and user-visible status handling.

## Finding sessions

`findSessions({ claudeHome, codexHome, since })` lists sessions modified at or after `since`, newest first, with their source, path, source id, and working directory:

- Claude Code: top-level `projects/*/*.jsonl` files whose first records include a working directory and a user prompt. Print-mode and SDK sessions (`sdk-*` entrypoints) and subagent transcripts are excluded. The source id is the file name.
- Codex: `sessions/**/rollout-*.jsonl` and `.jsonl.zst` files whose session metadata comes from the CLI or an IDE (`cli` or `vscode`). Other sources such as `exec` and subagent threads are excluded, and only the newest rollout of each thread is kept.

Discovery reads only the beginning of each recent file and never modifies it.

## Messages

Each source turn becomes a user message with the original prompt and, when the turn produced output, one assistant message. Assistant text is kept verbatim. Tool calls become `[external_agent_tool_call: NAME]` notes that list the `description`, `command` (or `cmd`) and `file_path` (or `file`) arguments, or the first 2,000 characters of the raw input when none of them exist. Tool results become `[external_agent_tool_result]` notes, marked `: error` when the source flagged an error, with the first 4,000 characters of their text. Clipping never splits an image reference. Returned messages contain no executable tool calls.

Thinking, source events, injected source context, and API error records are not rendered; they remain in the full history attachment. A turn without a user prompt is appended to the previous assistant message, and assistant output before the first prompt is dropped. A source compaction summary becomes the first user message.

The final user message starts with `<EXTERNAL SESSION IMPORTED>` and states the source session, how many turns are included, the full history and image index paths, and known source limitations. Messages always start with a user message and never contain two consecutive assistant messages.

## Budget and selection

The default token budget is `floor(contextWindow * 0.8)`. `tokenBudget` overrides this with an explicit allowance up to `contextWindow`. The estimator counts ASCII characters at four per token and non-ASCII code points at one each, plus message role overhead. This is an estimate, not a provider tokenizer.

Hosts should pass an allowance that accounts for their system prompt, tools, output reserve, and compaction policy. Eighty percent is a conversion default, not a guarantee against immediate compaction. The library does not depend on or change a host's compaction policy.

Whole turns are kept from the newest backwards until the next older turn would not fit; earlier turns remain only in the attachment. When the newest turn alone exceeds the budget, its prompt is kept, or only the ending of the prompt when the prompt itself is too large, together with the latest part of its assistant message. There is no LLM summarization or synthesized overview.

## Attachments

Before selecting model context, the package saves the complete **effective** history as `effective-history-<sha256>.jsonl`. Its first record contains format version 1, source metadata, issues, and image references; subsequent records contain complete turns, including thinking, events, and full tool input and output. Text omitted from the messages remains available here after the source file is removed.

Effective history means the selected branch and source compaction replacement, not every record in the original log. Discarded branches and pre-compaction records not retained by the source are not reconstructed. Encrypted compaction has no fabricated plaintext fallback and is reported as a known limitation.

Embedded PNG, JPEG, GIF, and WebP images are saved byte-for-byte under `images/`, deduplicated by SHA-256, and represented as paths at their original positions. Existing local paths are resolved against the source working directory; URLs are retained without downloading. Their existence and continued availability are not guaranteed. The image index includes references in effective history that the context budget later omits. Image paths use the same text budget as other content.

Attachments are written to private temporary files before atomic publication. Existing mismatched files and symbolic or persistent hard links are rejected rather than overwritten. A failed conversion can leave completed content-addressed attachments or an unexposed temporary file; callers own the target session directory lifecycle.

## Result states

- `complete`: effective source history was converted without detected loss and every turn fit the budget.
- `partial`: output is usable but `issues` identifies known source limitations, unresolved references, or turns omitted for budget. `stage` distinguishes source, attachment, and context limitations. Budget omission does not delete the full history attachment. Reasoning is never rendered, so missing reasoning text is not reported.
- `unreliable`: conversion could not safely finish. `error` and `issues` contain an actionable code; no successful message array is returned. `EMPTY_SOURCE_HISTORY` means the source has no user prompt or compaction summary to import, and no attachment is written.

Known unsupported cases include Codex sessions that were forked or restarted from an earlier message, whose history is partly stored in another rollout file, legacy compaction without replacement history, and ambiguous rollbacks across compaction or inter-agent messages. Malformed JSON and unresolved source-chain links are reported as partial rather than silently called complete. These states describe conversion fidelity, not the accuracy of a future model response.
