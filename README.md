# Telegram Codex Bridge

A small, zero-dependency Telegram Bot API bridge that connects a Telegram bot to a persistent `codex app-server` session.

It supports private chats, group chats, mention-only mode, recent group context, batched group replies, bot-loop limits, outbound rate limiting, image attachments, regular file attachments with text previews, optional private-chat tool execution, and prompt-scope isolation between private chats and public groups.

中文文档见 [README.zh-CN.md](README.zh-CN.md).

## What This Is

This project is a sanitized public version of a local Telegram-to-Codex bridge. It contains no private bot token, chat ID, logs, session IDs, downloaded files, or personal prompt content.

## Requirements

- macOS, Linux, or another machine that can run Node.js
- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Codex installed and authenticated on the same machine
- The Telegram bot must be able to receive the messages you want:
  - Disable BotFather Privacy Mode if the bot should see all group messages.
  - Enable bot-to-bot communication if you want another bot to trigger it.

## Quick Start

```bash
git clone https://github.com/SsssssSynqa/Codex-tg-Bridge.git
cd Codex-tg-Bridge
cp .env.example .env
cp config.example.json config.json
```

Edit `.env`:

```bash
TELEGRAM_BOT_TOKEN=1234567890:your-real-token
```

Edit `config.json`:

- Set `allowedUserIds` to your Telegram numeric user ID.
- Set `workdir` to the folder where Codex should run.
- Add any group chat IDs under `allowedGroups`.
- Leave `privateToolsEnabled` as `false` until you understand the tool safety model.

Then run:

```bash
npm run check
npm start
```

Send `/start` to your bot in Telegram. If your user ID is authorized, it should reply.

## Telegram Commands

Private-chat commands:

- `/start`: confirm the bridge is reachable.
- `/status`: show bridge status, active session, and group count.
- `/session`: show the active Codex thread ID.
- `/resume <thread-id>` or `/attach <thread-id>`: switch the bridge to an existing Codex thread.
- `/tools`: show whether private tool mode is enabled, writable roots, network mode, and the group-chat read-only rule.
- `/new`: start a fresh Codex session while preserving the previous session ID locally.

## Getting Telegram IDs

Invite [@getidsbot](https://t.me/getidsbot) to a chat, then use its output:

- Your private user ID goes into `allowedUserIds`.
- Group IDs go under `allowedGroups`.
- Bot IDs can be listed in group `allowedUserIds` if you want specific bots to trigger this bot.

Group IDs usually look like `-1001234567890`.

## Configuration

```json
{
  "botName": "Codex",
  "ownerName": "you",
  "allowedUserIds": ["123456789"],
  "allowedGroups": {
    "-1001234567890": {
      "title": "Example group",
      "requireMention": true,
      "allowAllHumanUsers": false,
      "allowAllBotUsers": false,
      "allowUnaddressedBotMessages": false,
      "allowedUserIds": ["123456789"],
      "maxConsecutiveBotMessages": 4,
      "mentionContext": {
        "enabled": true,
        "messageCount": 10,
        "recordAllDeliveredMessages": true
      },
      "promptInstructions": "Optional per-group style and privacy rules."
    }
  },
  "workdir": "/absolute/path/to/your/codex/workspace",
  "privateToolsEnabled": false,
  "toolWritableRoots": ["/absolute/path/to/your/codex/workspace"],
  "toolNetworkAccess": false
}
```

Important top-level options:

- `botName`: name inserted into prompts.
- `ownerName`: private-chat owner label inserted into prompts.
- `workdir`: working directory for Codex.
- `model`: Codex model, default `gpt-5.5`.
- `reasoningEffort`: Codex reasoning effort, default `medium`.
- `serviceTier`: app-server service tier override, default `fast`.
- `privateToolsEnabled`: when `true`, private chats can run Codex in restricted workspace-write mode.
- `toolWritableRoots`: absolute or config-relative paths that private tool mode may write inside.
- `toolNetworkAccess`: network access for private tool mode. Default `false`.

Important group options:

- `requireMention`: when `true`, group messages must mention the bot or reply to it.
- `allowAllHumanUsers`: when `true`, any non-bot human in that group can trigger the bridge.
- `allowAllBotUsers`: when `true`, any bot in that group can trigger the bridge. Use carefully.
- `allowUnaddressedBotMessages`: lets listed bot users trigger without mentioning this bot.
- `maxConsecutiveBotMessages`: stops accidental bot-to-bot loops.
- `mentionContext`: when the bot is mentioned or replied to, include recent group messages as read-only context.
- `promptInstructions`: group-specific behavior and privacy rules inserted into the prompt.

## Private Tool Mode

By default the bridge is read-only. Set `privateToolsEnabled: true` only if you want Telegram private chats to perform local Codex work.

When private tool mode is enabled:

- Private chats use a restricted `workspaceWrite` sandbox.
- Writes are limited to `toolWritableRoots`.
- Network access is disabled unless `toolNetworkAccess: true`.
- Group chats remain read-only for every turn.
- The bridge auto-declines approval requests that try to leave configured writable roots, request network approval, include token-shaped command text, or run dangerous commands such as recursive deletion, hard resets, force pushes, broad permission changes, disk operations, or destructive `launchctl` actions.

This is still a remote-control surface. Keep `allowedUserIds` strict, keep your bot token private, and avoid enabling tool mode for shared accounts.

## Prompt-Scope Isolation

The bridge uses a single persistent Codex thread by default, so private chats and group chats may share history. To reduce style and privacy bleed:

- Private prompts explicitly state that group-specific rules do not apply to private chat.
- Group prompts explicitly state that group-specific rules apply only to that group and that turn/batch.
- Group turns are always read-only even when private tool mode is enabled.

If you need stronger isolation, use separate bridge instances or separate sessions for different contexts.

## Mention-Only With Recent Context

For quieter groups, keep `requireMention: true`. The bridge will not answer ordinary group messages, but it can still remember the latest delivered messages in memory. When someone mentions the bot or replies to it, the prompt includes recent messages as context so Codex can understand references like "that thing above".

The default `mentionContext.messageCount` is `10`. This history is in-memory only and is not written to disk.

Important Telegram limitation: the bot can only remember messages Telegram actually delivers to it. If BotFather Privacy Mode is enabled, ordinary group messages may never reach the bridge. Disable Privacy Mode for groups where you want mention-triggered recent context.

## Attachments

Telegram `photo` messages and image documents are downloaded into `telegram-images/` and passed to Codex as `localImage` inputs.

Regular Telegram files are downloaded into `telegram-files/`. The bridge includes file metadata, the local path, and any extractable text preview in the prompt.

Text previews are extracted directly for common text/code/data files such as `.txt`, `.md`, `.json`, `.csv`, `.html`, `.js`, `.ts`, `.py`, `.yaml`, and similar formats. On macOS, `.doc`, `.docx`, `.rtf`, and `.odt` use `textutil` when available. Unsupported binary files are still downloaded, but the bridge only includes metadata and the local path; Codex is instructed not to pretend it has read the full file body when no preview is available.

Attachment caches are ignored by git. By default, images larger than 10 MB and regular files larger than 20 MB are skipped.

## Token Rotation

If you paste a token into a chat, issue tracker, or log, rotate it:

1. Open [@BotFather](https://t.me/BotFather).
2. Use `/revoke` or the token-management flow for your bot.
3. Replace `TELEGRAM_BOT_TOKEN` in `.env`.
4. Restart the bridge.

Never commit `.env`.

## macOS LaunchAgent

A LaunchAgent template is included in `launchd/com.example.telegram-codex-bridge.plist`.

Edit paths first, then install:

```bash
cp launchd/com.example.telegram-codex-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.telegram-codex-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.telegram-codex-bridge
```

Check status:

```bash
launchctl print gui/$(id -u)/com.example.telegram-codex-bridge
```

## Safety Notes

- Never commit `.env`, `config.json`, session files, offsets, logs, downloaded images, or downloaded files.
- Keep `allowedUserIds` narrow.
- Keep private tool mode off unless you need it.
- Group-wide `allowAllBotUsers` can create loops. Use it only temporarily or with strict `maxConsecutiveBotMessages`.
- Do not set `toolWritableRoots` to your home directory or filesystem root.

## Troubleshooting

- No group messages arrive: disable Privacy Mode in BotFather.
- Bot cannot see other bots: enable Bot to Bot Communication Mode in BotFather.
- Bot ignores a group: add the group ID to `allowedGroups`.
- Bot replies too often: turn on `requireMention` or lower `maxConsecutiveBotMessages`.
- Images are ignored: make sure Telegram sends them as `photo` or image documents under `imageMaxBytes`.
- Files are ignored: make sure they are under `fileMaxBytes`; if a file has no text preview, check whether its format is binary or unsupported.
- Private tool work does not happen: check `/tools`, confirm `privateToolsEnabled: true`, and make sure the target path is inside `toolWritableRoots`.

## License

MIT
