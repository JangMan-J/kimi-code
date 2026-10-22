# Session import

This Node.js package converts one external session into textual injection messages and session-owned attachments. It has no engine, provider, CLI, or UI dependency and does not create or resume a session.

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

`source` accepts `claude-code` and `codex`. The latter supports JSONL and JSONL.zst. An optional `stateDatabasePath` enables read-only title lookup for that source. Source files are never modified. `attachmentDirectory` must be an absolute path owned by the target session. The host appends returned messages through its existing context API and owns session creation, persistence, and user-visible status handling.

## Budget and selection

The default token budget is `floor(contextWindow * 0.8)`. `tokenBudget` overrides this with an explicit allowance up to `contextWindow`. The estimator counts ASCII characters at four per token and non-ASCII code points at one each, plus message role overhead. This is an estimate, not a provider tokenizer.

Hosts should pass an allowance that accounts for their system prompt, tools, output reserve, and compaction policy. Eighty percent is a conversion default, not a guarantee against immediate compaction. The library does not depend on or change a host's compaction policy.

Messages retain a chronological suffix of the effective source history. Whole recent turns are preferred; at the boundary, earlier blocks or the beginning of one block may be omitted. No user, assistant, thinking, or tool-result semantic priority is applied. There is no LLM summarization or synthesized tool-activity overview. Source roles and tool-call identifiers are textual labels; returned messages contain no executable tool calls.

The final injection contains source attribution, history and image-index paths, source limitations, and omission counts. Detailed metadata is retained in the full history attachment; tool error flags, exit codes, status, and call identifiers remain in the model-facing records.

## Attachments

Before selecting model context, the package saves the complete **effective** history as `effective-history-<sha256>.jsonl`. Its first record contains format version 1, source metadata, issues, and image references; subsequent records contain complete turns. Text omitted by the model-context budget remains available here after the source file is removed.

Effective history means the selected branch and source compaction replacement, not every record in the original log. Discarded branches and pre-compaction records not retained by the source are not reconstructed. Encrypted compaction has no fabricated plaintext fallback and is reported as a known limitation.

Embedded PNG, JPEG, GIF, and WebP images are saved byte-for-byte under `images/`, deduplicated by SHA-256, and represented as paths at their original positions. Existing local paths are resolved against the source working directory; URLs are retained without downloading. Their existence and continued availability are not guaranteed. The image index includes references in effective history that the context budget later omits. Image paths use the same text budget as other content.

Attachments are written to private temporary files before atomic publication. Existing mismatched files and symbolic or persistent hard links are rejected rather than overwritten. A failed conversion can leave completed content-addressed attachments or an unexposed temporary file; callers own the target session directory lifecycle.

## Result states

- `complete`: effective source history was converted without detected loss and all rendered history fit the budget.
- `partial`: output is usable but `issues` identifies known source limitations, unresolved references, or context omitted for budget. `stage` distinguishes source, attachment, and context limitations. Budget omission does not delete the full history attachment.
- `unreliable`: conversion could not safely finish. `error` and `issues` contain an actionable code; no successful message array is returned.

Known unsupported cases include external ancestor-history references, legacy compaction without replacement history, and ambiguous rollbacks across compaction or inter-agent messages. Malformed JSON and unresolved source-chain links are reported as partial rather than silently called complete. These states describe conversion fidelity, not the accuracy of a future model response.
