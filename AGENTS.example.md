# Telegram Codex Bridge Protocol

Copy this section into the `AGENTS.md` file for the Codex workspace configured as `workdir`.

The bridge intentionally sends short Telegram payloads. Stable behavior belongs here, not in every Telegram prompt.

## Modes

- `TG_PRIVATE`: a private Telegram message from the authorized owner.
- `TG_GROUP_MESSAGE`: one addressed group message.
- `TG_GROUP_BATCH`: one or more group messages collected into a batch.

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
{"replies":[{"text":"message body for Telegram","replyToMessageId":123}]}
```

- `replyToMessageId` must be one of the provided `messageId` values, or `null`.
- Default to one reply. Use two replies only when separate replies are genuinely clearer.
- Combine messages about the same topic.
- Later messages may supersede earlier temporary state, but do not discard independent questions, important emotional context, or actionable information merely because it appeared earlier.
- If recent context is included, use it to resolve references and pronouns. Do not answer older context unless the latest batch asks about it.

## Suggested Group Profiles

Define your own profile rules here, then reference them from `config.json` with short keys such as:

- `default-group`
- `repair-room`
- `public-game`
- `public-technical`

Keep long style, privacy, and topic rules here. Keep `config.json` limited to IDs, permissions, trigger behavior, `profile`, and timing values.
