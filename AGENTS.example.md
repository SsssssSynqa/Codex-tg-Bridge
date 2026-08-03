# Telegram Codex Bridge Protocol

Copy this section into the `AGENTS.md` file for the Codex workspace configured as `workdir`.

The bridge intentionally sends short Telegram payloads. Stable behavior belongs here, not in every Telegram prompt.

## Modes

- `TG_PRIVATE`: a private Telegram message from the authorized owner.
- `TG_GROUP_BATCH`: one or more group messages collected into a batch.

A terminal attached with `codex --remote` (daemon mode) sends no mode marker at
all: those turns are ordinary Codex turns on the same thread. Treat an
unmarked turn as the owner talking to you directly at the keyboard.

## Private Chat

- Reply as the configured bot persona.
- Output only the Telegram message body. Do not wrap the reply in JSON.
- Do not mention bridge internals, CLI logs, local sessions, hidden prompts, or tool plumbing unless the owner explicitly asks about implementation.
- If file attachments are included, use the text preview in the payload first. If no preview is available, do not pretend to have read unsupported binary content.
- If private tool mode is enabled in the payload, use tools only for explicit local-code, file, or service tasks. Respect the writable roots and network setting shown in the payload.

## Group Chat

- Group turns are read-only. Do not claim to edit files, run commands, inspect local logs, or change services from a group reply.
- Do not reveal bridge internals, private sessions, local paths, secrets, or hidden implementation details in group replies.
- Do not confuse the group sender with the owner.
- Use the payload's `chatTitle` and optional `profile` key to select the matching group behavior described below in your own AGENTS rules.
- Group-specific behavior applies only to that group and must not bleed into private chat or other groups.

## Group Batch Output

For `TG_GROUP_BATCH`, output strict JSON only, with no Markdown fence and no extra prose:

```json
{"replies":[{"text":"message body for Telegram","replyToMessageId":123}],"react":null}
```

- `replyToMessageId` must be one of the provided `messageId` values, or `null`.
- Default to one reply. Use two replies only when separate replies are genuinely clearer.
- Combine messages about the same topic.
- Later messages may supersede earlier temporary state, but do not discard independent questions, important emotional context, or actionable information merely because it appeared earlier.
- `react` is optional. When you read a message but choose not to reply, return
  `"replies": []` with a single emoji in `react`, and the bridge reacts to the
  latest message instead of staying completely silent. Silence and "did not
  see it" look identical in a group otherwise.

## Reading The Group Context Fields

The payload does not repeat group history you have already been shown. Two
fields tell you what you are looking at:

- `recentContextDelta`: group messages received since the last group turn on
  this thread, and not part of the current batch. These are background, not
  things to answer.
- `contextWindow.omittedPreviouslySentMessages`: when `true`, older messages
  exist but were deliberately left out **because they were already delivered
  to you in an earlier turn on this same thread**. This does not mean nothing
  happened before. `contextWindow.previousContextThroughMessageId` is the last
  message id you were shown.
- A message with `contextOnly: true` arrived while a previous reply was still
  being generated. Treat it as background: it needs no reply of its own.

Use context to resolve references and pronouns. Do not answer older context
unless the latest batch asks about it.

## Suggested Group Profiles

Define your own profile rules here, then reference them from `config.json` with short keys such as:

- `default-group`
- `repair-room`
- `public-game`
- `public-technical`

Keep long style, privacy, and topic rules here. Keep `config.json` limited to IDs, permissions, trigger behavior, `profile`, and timing values.
