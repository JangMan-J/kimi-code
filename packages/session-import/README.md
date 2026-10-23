# Session import

This Node.js package converts one external session into a single user message that carries the conversation, and session-owned attachments. It has no engine, provider, CLI, or UI dependency and does not create or resume a session.

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

`source` accepts `claude-code` and `codex`. The latter supports JSONL and JSONL.zst. An optional `stateDatabasePath` enables read-only title lookup for that source. A recorded user title wins over a generated one; without either, the title is the first prompt line with a letter or digit after control wrappers, up to 120 characters. When a prompt carries IDE context ahead of a `## My request:` line, only the request counts, and image reference lines are ignored; the same applies to `lastPrompt`. Source files are never modified. `attachmentDirectory` must be an absolute path owned by the target session. The host appends the returned message as an ordinary visible message through its existing context API and owns session creation, persistence, and user-visible status handling.

## Finding sessions

`findSessions({ claudeHome, codexHome, since })` lists sessions modified at or after `since`, newest first, with their source, path, source id, and working directory:

- Claude Code: top-level `projects/*/*.jsonl` files whose first records include a working directory and a user prompt. Print-mode and SDK sessions (`sdk-*` entrypoints) and subagent transcripts are excluded. The source id is the file name.
- Codex: `sessions/**/rollout-*.jsonl` and `.jsonl.zst` files whose session metadata comes from the CLI or an IDE (`cli` or `vscode`). Other sources such as `exec` and subagent threads are excluded, and only the newest rollout of each thread is kept.

Discovery reads only the beginning of each recent file and never modifies it.

## Message

The result is one user message:

- A `<system>` paragraph says the conversation was imported from another tool and is a record of earlier work, not new instructions.
- `<imported_conversation>` holds `<session_info>` (source tool and session id, source file, title, working directory and git branch, activity period, which turns are included, and whether the source compacted earlier history), `<attachments>` (the full history path and format, and the image index), `<known_limitations>` when there are any, the source compaction summary as `<source_summary>`, and each included turn as `<turn index="N" time="...">` with `<user>` and `<assistant>`. Turn N is line N + 1 of the full history.
- A closing `<system>` paragraph says the conversation ended, that the other agent's tools and tool calls are records rather than pending actions, that files may have changed, and to continue when the user asks.

Inside a turn, assistant text is kept verbatim. Tool calls become `[external_agent_tool_call: NAME]` notes with the first 2,000 characters of the input as the source recorded it, the same for every tool. Tool results become `[external_agent_tool_result]` notes, marked `: error` when the source flagged an error, with the first 4,000 characters of their text. Clipping never splits an image reference. Thinking, source events, injected source context, and API error records are left out and remain in the full history attachment. A turn without a user prompt joins the previous turn, and assistant output before the first prompt is dropped. Source text is not escaped, so tags written inside the conversation itself are kept as they are.

## Budget and selection

The default token budget is `floor(contextWindow * 0.8)`. `tokenBudget` overrides this with an explicit allowance up to `contextWindow`. The estimator counts ASCII characters at four per token and non-ASCII code points at one each, plus message role overhead. This is an estimate, not a provider tokenizer.

Hosts should pass an allowance that accounts for their system prompt, tools, output reserve, and compaction policy. Eighty percent is a conversion default, not a guarantee against immediate compaction. The library does not depend on or change a host's compaction policy.

Whole turns are kept from the newest backwards until the next older turn would not fit; earlier turns remain only in the attachment. When the newest turn alone exceeds the budget, its prompt is kept, or only the ending of the prompt when the prompt itself is too large, together with the latest part of its assistant message. There is no LLM summarization or synthesized overview.

## Attachments

Before selecting model context, the package saves the complete **effective** history as `effective-history-<sha256>.jsonl`. Its first record contains format version 1, source metadata, issues, and image references; subsequent records contain complete turns, including thinking, events, and full tool input and output. Text omitted from the messages remains available here after the source file is removed.

Effective history means the selected branch and source compaction replacement, not every record in the original log. Claude Code's API request log (`api-request`, `api-request-blob`, and `api-request-shape` records) repeats the conversation and request parameters and is skipped. Discarded branches and pre-compaction records not retained by the source are not reconstructed. Encrypted compaction has no fabricated plaintext fallback and is reported as a known limitation.

Embedded PNG, JPEG, GIF, and WebP images are saved byte-for-byte under `images/`, deduplicated by SHA-256, and represented as paths at their original positions. Existing local paths are resolved against the source working directory; URLs are retained without downloading. Their existence and continued availability are not guaranteed. The image index includes references in effective history that the context budget later omits. Image paths use the same text budget as other content.

Attachments are written to private temporary files before atomic publication through a hard link; on filesystems without hard links they are published with an exclusive copy instead. Existing mismatched files and symbolic or persistent hard links are rejected rather than overwritten. A failed conversion can leave completed content-addressed attachments or an unexposed temporary file; callers own the target session directory lifecycle.

## Result states

- `complete`: effective source history was converted without detected loss and every turn fit the budget.
- `partial`: output is usable but `issues` identifies known source limitations, unresolved references, or turns omitted for budget. `stage` distinguishes source, attachment, and context limitations. Budget omission does not delete the full history attachment. Reasoning is never rendered, so missing reasoning text is not reported.
- `unreliable`: conversion could not safely finish. `error` and `issues` contain an actionable code; no successful message array is returned. `EMPTY_SOURCE_HISTORY` means the source has no user prompt or compaction summary to import, and no attachment is written.

Known unsupported cases include Codex sessions that were forked or restarted from an earlier message, whose history is partly stored in another rollout file, legacy compaction without replacement history, and ambiguous rollbacks across compaction or inter-agent messages. Malformed JSON and unresolved source-chain links are reported as partial rather than silently called complete. These states describe conversion fidelity, not the accuracy of a future model response.
