# Telegram Codex Bridge

A small, zero-dependency Telegram Bot API bridge that connects a Telegram bot to a persistent `codex app-server` session.

It supports private chats, group chats, mention-only mode, recent context on mentions, batched group replies, loop limits for bot-to-bot conversations, outbound rate limiting, Telegram image attachments, and regular Telegram file attachments with text previews.

## What This Is

This project is a sanitized public version of a local bridge used to run a personal Codex bot from Telegram. It contains no private bot token, chat ID, logs, session IDs, or personal prompt content.

## Requirements

- macOS, Linux, or another machine that can run Node.js
- Node.js 20+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- Codex installed and authenticated on the same machine
- The Telegram bot must be able to receive the messages you want:
  - In BotFather, disable Privacy Mode if the bot should see all group messages.
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

Then run:

```bash
npm run check
npm start
```

Send `/start` to your bot in Telegram. If your user ID is authorized, it should reply.

## Getting Telegram IDs

Invite [@getidsbot](https://t.me/getidsbot) to a chat, then use its output:

- Your private user ID goes into `allowedUserIds`.
- Group IDs go under `allowedGroups`.
- Bot IDs can be listed in `allowedUserIds` if you want specific bots to trigger this bot.

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
  }
}
```

Important group options:

- `requireMention`: when `true`, group messages must mention the bot or reply to it.
- `allowAllHumanUsers`: when `true`, any non-bot human in that group can trigger the bridge.
- `allowAllBotUsers`: when `true`, any bot in that group can trigger the bridge. Use carefully.
- `allowUnaddressedBotMessages`: lets listed bot users trigger without mentioning this bot.
- `maxConsecutiveBotMessages`: stops accidental bot-to-bot loops.
- `mentionContext`: when the bot is mentioned or replied to, include recent group messages as read-only context.
- `promptInstructions`: group-specific behavior and privacy rules inserted into the prompt.

## Mention-Only With Recent Context

For quieter groups, keep `requireMention: true`. The bridge will not answer ordinary group messages, but it can still remember the latest delivered messages in memory. When someone mentions the bot or replies to it, the prompt includes the recent messages as context so Codex can understand references like "that thing above".

The default `mentionContext.messageCount` is `10`. This history is in-memory only and is not written to disk.

Important Telegram limitation: the bot can only remember messages Telegram actually delivers to it. If BotFather Privacy Mode is enabled, ordinary group messages may never reach the bridge. Disable Privacy Mode for groups where you want mention-triggered recent context.

Privacy-related options:

- `mentionContext.enabled`: turn recent mention context on or off.
- `mentionContext.messageCount`: how many recent delivered messages to include when the bot is addressed.
- `mentionContext.maxStoredMessages`: how many delivered messages to keep in memory per group.
- `mentionContext.maxMessageChars`: maximum text stored per message.
- `mentionContext.recordAllDeliveredMessages`: when `true`, remember delivered messages from all members in an allowed group, even if they cannot trigger replies.

## Attachments

Telegram `photo` messages and image documents are downloaded into `telegram-images/` and passed to Codex as `localImage` inputs.

Regular Telegram files are downloaded into `telegram-files/`. The bridge includes file metadata, the local path, and any extractable text preview in the prompt.

Text previews are extracted directly for common text/code/data files such as `.txt`, `.md`, `.json`, `.csv`, `.html`, `.js`, `.ts`, `.py`, `.yaml`, and similar formats. On macOS, `.doc`, `.docx`, `.rtf`, and `.odt` use `textutil` when available. Unsupported binary files are still downloaded, but the bridge only includes metadata and the local path; Codex is instructed not to pretend it has read the full file body when no preview is available.

Attachment caches are ignored by git. By default, images larger than 10 MB and regular files larger than 20 MB are skipped.

Relevant options:

- `imageMaxBytes`: maximum image attachment size.
- `fileMaxBytes`: maximum regular file attachment size.
- `attachmentTextMaxChars`: maximum text preview characters per file.

## Safety Notes

- Never commit `.env`, `config.json`, session files, offsets, logs, downloaded images, or downloaded files.
- If you ever paste a bot token into a chat or issue tracker, rotate it in BotFather.
- Group-wide `allowAllBotUsers` can create loops. Use it only temporarily or with strict `maxConsecutiveBotMessages`.
- The bridge runs Codex with `approvalPolicy: "never"` and `sandbox: "read-only"` by default.

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

## Troubleshooting

- No group messages arrive: disable Privacy Mode in BotFather.
- Bot cannot see other bots: enable Bot to Bot Communication Mode in BotFather.
- Bot ignores a group: add the group ID to `allowedGroups`.
- Bot replies too often: turn on `requireMention` or lower `maxConsecutiveBotMessages`.
- Images are ignored: make sure Telegram sends them as `photo` or image documents under `imageMaxBytes`.
- Files are ignored: make sure they are under `fileMaxBytes`; if a file has no text preview, check whether its format is binary or unsupported.

## License

MIT
