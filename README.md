# Telegram Codex Bridge

A small, zero-dependency Telegram Bot API bridge that connects a Telegram bot to a persistent `codex app-server` session.

It supports private chats, group chats, mention-only mode, delta group context, batched group replies, bot-loop limits, outbound rate limiting, image and file attachments, optional private-chat tool execution, owner-approved command execution, crash-safe message delivery, and — in daemon mode — a terminal session that shares one live thread with Telegram.

中文文档见 [README.zh-CN.md](README.zh-CN.md).

## What This Is

Telegram Codex Bridge lets you run a Telegram bot as a lightweight front end for a persistent Codex session. It is designed for personal automation, small trusted groups, and bot-to-bot workflows where you want Codex available from Telegram — and, if you want it, from a terminal window attached to that same conversation.

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

Copy the protocol from `AGENTS.example.md` into the `AGENTS.md` file for your configured `workdir`. Put long persona, privacy, and group-profile rules there. Do not put long behavior prompts in `config.json`; the bridge sends only short mode markers plus dynamic Telegram payloads on each turn.

Then run:

```bash
npm run check
npm start
```

Send `/start` to your bot in Telegram. If your user ID is authorized, it should reply.

## Telegram Commands

Private-chat commands:

- `/start`: confirm the bridge is reachable.
- `/status`: bridge mode, active thread, group counts, and the delivery queue (pending, in-flight, dead-lettered).
- `/session`: show the active Codex thread ID.
- `/resume <thread-id>` or `/attach <thread-id>`: switch the bridge to an existing Codex thread.
- `/tools`: show whether private tool mode is enabled, writable roots, network mode, and the group-chat read-only rule.
- `/new`: start a fresh Codex thread while preserving the previous thread ID locally.
- `/retry_update <update-id>`: put one dead-lettered Telegram update back in the queue.

Owner-only operations:

- `/reload_config`: re-read `config.json` in place and hot-swap `allowedGroups`, `mentionPatterns`, and `mentionContext`. Static fields (`codexMode`, `model`, `timeoutMs`, `keychain*`) still need a restart.
- `/restart_bridge`: exit cleanly so the process manager restarts the bridge. The replacement process edits the original "restarting" message into a confirmation.
- `/restart_daemon`: restart the Codex daemon via `launchctl kickstart` without stopping the bridge (macOS + daemon mode only).
- `/force_restart_bridge`, `/force_restart_daemon`: same, but allowed while a turn is in flight. Without `force_`, both refuse rather than interrupting work.

Group commands (see [Dynamic Group Authorization](#dynamic-group-authorization)):

- `/<prefix>_on`, `/<prefix>_off`, `/<prefix>_all`, `/<prefix>_quiet`

## Getting Telegram IDs

Invite [@getidsbot](https://t.me/getidsbot) to a chat, then use its output:

- Your private user ID goes into `allowedUserIds`.
- Group IDs go under `allowedGroups`.
- Bot IDs can be listed in group `allowedUserIds` if you want specific bots to trigger this bot.

Group IDs usually look like `-1001234567890`.

## Configuration

See `config.example.json` for the full set. The options that matter most:

| Key | Meaning |
| --- | --- |
| `botName` / `ownerName` | Names included in the short Telegram payload. |
| `allowedUserIds` | Telegram user IDs allowed to use private chat. |
| `ownerUserId` | Who may use ops commands, approval buttons, and gate commands. Defaults to the first entry of `allowedUserIds`. |
| `mentionPatterns` | Extra wake words. In a `requireMention` group, a message containing one of these counts as addressing the bot. |
| `gateCommandPrefix` | Prefix for the group gate commands. Defaults to `botName`. |
| `workdir` | Working directory for Codex. |
| `model`, `reasoningEffort`, `serviceTier` | Codex turn settings. |
| `privateToolsEnabled` | When `true`, private chats can run Codex in restricted workspace-write mode. |
| `toolWritableRoots` | Absolute (or config-relative) paths private tool mode may write inside. |
| `toolNetworkAccess` | Network access for private tool mode. Default `false`. |
| `codexMode` | `"spawn"` (own child process) or `"daemon"` (shared session — see below). |
| `daemonSocketPath` | Override the daemon socket. Empty means `$CODEX_HOME/app-server-control/app-server-control.sock`. |
| `daemonLaunchdLabel` | launchd label used by `/restart_daemon`. |
| `approvalTimeoutMs` | How long an approval card waits before auto-declining. Default 60000. |
| `desktopSync` | Opt-in: rewrite this thread's row in the Codex Desktop sidebar. |
| `liveLogEnabled` | Opt-in: write a local JSONL transcript of every message in and out. |
| `outboxEnabled` | Opt-in: let local scripts send messages by appending to a file. |

Per-group options:

- `requireMention`: when `true`, group messages must mention the bot, reply to it, or hit a `mentionPatterns` wake word.
- `allowAllHumanUsers` / `allowAllBotUsers`: let any human / any bot in that group trigger the bridge. Use `allowAllBotUsers` carefully.
- `allowUnaddressedBotMessages`: lets listed bot users trigger without mentioning this bot.
- `maxConsecutiveBotMessages`: stops accidental bot-to-bot loops. Any human message resets the counter.
- `disableReplyQuote`: send replies without quoting, which keeps two chatty bots from building a visible reply chain.
- `mentionContext`: how much recent group history to keep and deliver.
- `profile`: short key included in the payload so your `AGENTS.md` can select the matching group profile.
- `batchTiming`: per-group collection windows. Use longer windows for busy groups to reduce model calls.

`promptInstructions` is intentionally not used. Long group behavior and privacy rules belong in `AGENTS.md`, not in per-message bridge prompts.

### Storing the token in the macOS Keychain

Instead of `.env`, you can keep the token out of the filesystem entirely:

```bash
security add-generic-password -U -a bot-token -s com.example.telegram-codex-bridge -w 'YOUR_TOKEN'
```

Then add to `config.json`:

```json
{
  "keychainService": "com.example.telegram-codex-bridge",
  "keychainAccount": "bot-token"
}
```

`TELEGRAM_BOT_TOKEN` in the environment always wins if both are present.

## Terminal ↔ Telegram: One Session

This is the part that makes the bridge feel less like a bot and more like one assistant you can reach from two places.

In the default `codexMode: "spawn"`, the bridge starts its own `codex app-server --stdio` child. That child owns an isolated in-memory thread. If you also open Codex.app or run `codex --remote` in a terminal, each one gets its own Codex instance with diverging context — even when they read the same rollout file on disk.

In `codexMode: "daemon"`, the bridge is just one client of a long-running `codex app-server --listen unix://PATH`. Every client that resumes the same thread id shares one in-memory thread, and the daemon broadcasts events — token usage, message deltas, completions — to all of them. Type in Telegram, watch it appear in the terminal. Type in the terminal, and the next Telegram message continues that same conversation.

### 1. Install the daemon

```bash
cp launchd/com.example.codex-daemon.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.codex-daemon.plist
```

Edit `YOUR_USERNAME` in the plist first. Then verify the daemon is up and the socket is single-user (mode 0600):

```bash
launchctl list | grep com.example.codex-daemon
ls -la ~/.codex/app-server-control/app-server-control.sock
```

### 2. Point the bridge at it

```json
{
  "codexMode": "daemon",
  "daemonSocketPath": ""
}
```

Empty means the default `$CODEX_HOME/app-server-control/app-server-control.sock`. Restart the bridge, then confirm daemon mode is really live:

```bash
# In daemon mode the bridge has NO codex app-server child.
pgrep -P "$(launchctl list | awk '/telegram-codex-bridge$/{print $1}')"
```

Empty output means daemon mode. The bridge log says `Codex daemon ready`; `Codex spawn ready` means you are still on the spawn path.

### 3. Add a shortcut command for the terminal window

The raw invocation is long and easy to get wrong:

```bash
codex --remote unix:///Users/YOUR_USERNAME/.codex/app-server-control/app-server-control.sock
```

Put a shell function in `~/.zshrc` (or `~/.bashrc`) so one word opens the terminal window attached to the same thread your bot is talking on. Name it after your bot:

```bash
# Open the terminal side of the Telegram bridge: same daemon, same thread.
mybot() {
  codex --remote "unix://$HOME/.codex/app-server-control/app-server-control.sock" \
    -s workspace-write \
    --add-dir "$HOME/path/to/your/workspace" \
    "$@"
}
```

Reload with `source ~/.zshrc`, then just type:

```bash
mybot
```

**Why the extra `-s workspace-write --add-dir`?** A bare `codex --remote` attach inherits the baseline every thread starts with: `sandbox: 'read-only'`. It does not go through the bridge's `ask()`, so it never reaches `private-tools` mode the way a Telegram private-chat turn does. Without those two flags, the terminal window can read but not write, which is confusing when the same assistant can write when you message it on Telegram. Point `--add-dir` at the same directory as your `toolWritableRoots` to give both sides the same reach.

Approval policy is deliberately left at the TUI's own interactive default. You are sitting at the keyboard, so a risky command should ask *you*, right there — not silently auto-approve, and not turn into a Telegram card you have to go find.

If you prefer to keep the flags implicit even when you type the long command by hand, wrap `codex` itself and only touch this one socket (zsh):

```bash
codex() {
  local -a args=("$@")
  local i
  for (( i = 1; i <= $#; i++ )); do
    if [[ "${args[i]}" == "--remote" && "${args[i+1]}" == "unix://$HOME/.codex/app-server-control/app-server-control.sock" ]]; then
      set -- "$@" -s workspace-write --add-dir "$HOME/path/to/your/workspace"
      break
    fi
  done
  command codex "$@"
}
```

Any other `codex` usage — local runs, a different `--remote` target — is untouched.

### 4. Find the bridge's thread

Inside the TUI, list and resume the thread the bridge is using. Look for `serviceName: "codex-telegram"`, or read the id directly:

```bash
cat .state/session.txt
```

From then on, both surfaces target the same in-memory Codex.

### How approvals behave for terminal turns

The bridge receives approval requests for *every* turn on the shared thread, including turns you started in the terminal. It deliberately does not answer those as if they were its own:

- A dangerous command is still refused outright, whoever started it.
- A malformed file-change payload is refused, because a blank card is not a decision anyone can make.
- Everything else from a turn the bridge did not start is forwarded to the owner as a Telegram card — never auto-approved, even when every target is inside `toolWritableRoots`.

Before this rule existed, the bridge silently declined approvals belonging to the owner's own terminal session, and a plain `open ~/.codex` typed at the keyboard would be refused twice with no explanation. Group turns are unaffected: their turn ids are known to the bridge and stay hard read-only.

### Codex Desktop sidebar

Threads created by a headless app-server do appear in the Codex Desktop sidebar, but with a machine-generated title, the raw prompt as a preview, and no useful sort position. Set `"desktopSync": true` and the bridge rewrites that row after each turn: the title becomes `<botName> via Telegram`, the preview becomes the latest message, and the thread floats to the top of the recency list.

This writes to Codex's own local state database, which is why it is opt-in. It is best-effort in every failure path: if a Codex release changes that schema, the column probe disables the sync instead of writing garbage. Message text is encoded as a hex blob and cast back to TEXT, so chat content never passes through the sqlite parser.

### Trade-offs

- The daemon is `experimental` in upstream Codex. Pin a version and re-test after upgrades.
- The default unix socket is single-user (mode 0600). Do not expose `ws://0.0.0.0:PORT` unless you also configure the matching `--ws-auth` mode upstream.
- `/restart_daemon` drops any attached TUI with `Connection reset without closing handshake` — the Codex CLI has no auto-reconnect. Restart it by hand. The bridge itself reconnects on its own.
- Rollback is one line: set `codexMode` back to `"spawn"` and restart. The daemon LaunchAgent can be stopped separately with `launchctl bootout`.

## Approval Requests

When `privateToolsEnabled` is on, Codex asks before running commands or writing files. The bridge sorts those requests into three buckets:

1. **Auto-approved** — only side-effect-free inspection commands (`ls`, `cat`, `rg`, `git status/diff/log`, …) with no shell composition, substitution or redirection, running inside `toolWritableRoots`. Being inside the roots is not by itself enough.
2. **Auto-declined** — dangerous commands (recursive deletion, `sudo`, hard reset, force push, disk operations, destructive `launchctl`, piping into a shell, token-shaped text), anything during a read-only or group turn, and malformed payloads.
3. **Forwarded to you** — everything else, as a Telegram card with the command, its cwd, and any write targets outside the roots, plus two buttons: **✅ Approve** / **❌ Decline**.

Details worth knowing:

- **Every file write is forwarded**, including paths inside the writable roots. There is no silent write.
- A command whose cwd is safe can still write elsewhere via `>`, `cp`, `mv`, `tee`, `dd of=`, or `curl -o`. Those targets are extracted and listed on the card.
- There is no "approve for the rest of this turn". Every request needs its own tap.
- Unanswered cards auto-decline after `approvalTimeoutMs` (default 60s) and the card is edited to say so. If the daemon connection drops or the bridge force-restarts while a card is pending, it is edited to say it is no longer valid rather than being left looking actionable.
- Command and path text is redacted for common secret shapes (OpenAI/Anthropic keys, GitHub tokens, AWS keys, Bearer tokens, JWTs, PEM blocks, URL credentials, generic `key=value` pairs) before it leaves the machine.
- In spawn mode there is no asynchronous approval channel, so file changes are declined rather than silently approved. Use daemon mode if you want the buttons.

## Group Context: Delta Delivery

Re-sending the same recent messages on every mention wastes tokens and makes the model re-read what it already answered. Instead, each `(chatId, threadId)` pair keeps a cursor of the highest message id it has processed:

- A group turn receives only messages newer than the cursor, as `recentContextDelta`.
- `contextWindow.omittedPreviouslySentMessages` tells the model that older messages were left out because it already read them — not that nothing happened before.
- The cursor advances only after every reply in the batch has been accepted by Telegram. A model or send failure keeps the old cursor so a retry still sees those messages.
- Delta delivery never takes only the newest tail: every still-buffered unseen message is delivered, so a small display window cannot silently skip older context.
- The cursor key includes the thread id, so only an explicit `/new` or `/resume` starts a fresh context window.

Cursors live in `.state/group-context-cursors.json` (0600, atomic write).

## Reliable Delivery

Every inbound update is fsync'd to a journal **before** the Telegram poll offset advances, so a crash replays instead of dropping messages.

- Preparation and enqueue happen in `update_id` order; completion is recorded only after the actual send finishes.
- Private model output and its generating thread id are fsync'd before delivery, so a crash after generation re-sends the cached reply rather than adding a second model turn to the thread.
- Group generation fsyncs the exact batch membership, the parsed replies, the generating thread, and each accepted reply index. Recovery never regroups an old batch with newer input, and never resends a reply already acknowledged locally.
- `/new`, `/resume`, `/reload_config`, `/retry_update` and both restart commands use an operation intent/result journal, so a replay does not repeat a completed thread switch or loop a restart.
- Repeated failures back off exponentially and end in a visible dead-letter entry instead of silently advancing. `/status` shows the counts; `/retry_update <id>` requeues one.
- The operational journal compacts over time, but every accepted raw update is also fsync'd once to an append-only archive that is never rotated.

Delivery is intentionally at-least-once. A rare duplicate outbound message is still possible if Telegram accepts `sendMessage` but the network response is lost before the bridge observes it — Telegram exposes no idempotency key that can close that gap. A duplicate *model turn* is prevented by the cached output.

## Dynamic Group Authorization

Adding the bot to a new group normally means editing `config.json` and restarting. These owner-only commands do it from inside the group, in real time. The prefix comes from `gateCommandPrefix` (defaulting to `botName`), so a bot named `Codex` answers to:

- `/codex_on` — authorize this group, with conservative defaults (mention-only, no unaddressed bot messages, low bot-loop limit)
- `/codex_off` — remove that authorization
- `/codex_all` — read every message in this group
- `/codex_quiet` — back to mention-only

Dynamic authorizations live in `.state/dynamic-groups.json` (0600) and are a separate layer from `allowedGroups`. These commands never edit `config.json` and never remove a statically configured group. A non-owner attempt is consumed with a short refusal, and a corrupt state file fails closed rather than being silently replaced.

## Private Tool Mode

By default the bridge is read-only. Set `privateToolsEnabled: true` only if you want Telegram private chats to perform local Codex work.

When private tool mode is enabled:

- Private chats use a restricted `workspaceWrite` sandbox.
- Writes are limited to `toolWritableRoots`.
- Network access is disabled unless `toolNetworkAccess: true`.
- Group chats remain read-only for every turn.
- Command and file approvals follow the rules in [Approval Requests](#approval-requests).

Read-only here is a filesystem-write boundary, not a claim that read-capable tools are absent: a group turn can still run read-only shell operations against files the sandbox can see. The group prompt tells the model not to use tools and write/network approvals are denied, but this is not a cryptographic no-tools guarantee.

This is a remote-control surface. Keep `allowedUserIds` strict, keep your bot token private, and do not enable tool mode on a shared account.

## Prompt Protocol And Scope Isolation

The bridge uses a single persistent Codex thread by default, so private chats, group chats and any attached terminal share one history. That is the point of daemon mode — but it means style and privacy bleed are your responsibility:

- Stable Telegram rules live in your workspace `AGENTS.md`; start from `AGENTS.example.md`.
- Per-turn prompts are intentionally small: a mode marker such as `TG_PRIVATE` or `TG_GROUP_BATCH` plus a JSON payload with the current message(s).
- Group profiles are defined in `AGENTS.md` and selected by the short `profile` key.
- Group turns are always read-only, even when private tool mode is on.

If you need stronger isolation, run separate bridge instances with separate threads.

## Mention-Only With Recent Context

For quieter groups, keep `requireMention: true`. The bridge will not answer ordinary group messages, but it still remembers the latest delivered ones in memory. When someone mentions the bot, replies to it, or uses a `mentionPatterns` wake word, recent messages travel along as context so Codex understands references like "that thing above".

The default `mentionContext.messageCount` is `10`. This history is in memory only.

Important Telegram limitation: the bot can only remember messages Telegram actually delivers. If BotFather Privacy Mode is enabled, ordinary group messages may never reach the bridge. Disable Privacy Mode for groups where you want mention-triggered context.

## Attachments

Telegram `photo` messages and image documents are downloaded into `telegram-images/` and passed to Codex as `localImage` inputs.

Regular files are downloaded into `telegram-files/`. The bridge includes file metadata, the local path, and any extractable text preview in the prompt.

Text previews are extracted directly for common text/code/data files such as `.txt`, `.md`, `.json`, `.csv`, `.html`, `.js`, `.ts`, `.py`, `.yaml`. On macOS, `.doc`, `.docx`, `.rtf` and `.odt` use `textutil` when available. Unsupported binary files are still downloaded, but only metadata and the path are included; Codex is told not to pretend it read a body it never saw.

Attachment caches are ignored by git. By default, images over 10 MB and files over 20 MB are skipped.

## Local Outbox

With `"outboxEnabled": true`, appending a line to `.state/outbox.jsonl` sends a message:

```bash
echo '{"chatId":"123456789","text":"backup finished"}' >> .state/outbox.jsonl
```

Useful for cron jobs and scripts that want to reach the same chat without a second bot token. Omit `chatId` to send to the owner.

## Tests

```bash
npm run check   # syntax check every module
npm test        # full suite
```

The suite covers the security-sensitive parts: the dangerous-command list, the write-target extractor, the auto-approve allowlist, secret redaction, approval routing for external/terminal turns, gate-command authorization, crash replay of the durable inbox, and the desktop-sync SQL encoding.

Run it after **any** change to `command-policy.mjs`, `redact.mjs`, `gate-command.mjs`, `durable-update-inbox.mjs`, or the approval paths in either Codex client. Several of those cases exist because a real bug slipped through an earlier version.

## Token Rotation

If you paste a token into a chat, issue tracker, or log, rotate it:

1. Open [@BotFather](https://t.me/BotFather).
2. Use `/revoke` or the token-management flow for your bot.
3. Replace `TELEGRAM_BOT_TOKEN` in `.env` (or update the Keychain entry).
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

`KeepAlive` is what makes `/restart_bridge` work: the bridge exits, launchd starts it again within seconds. Any supervisor that restarts on exit (systemd, pm2, …) works the same way.

## Safety Notes

- Never commit `.env`, `config.json`, `.state/`, logs, downloaded images, or downloaded files.
- Keep `allowedUserIds` narrow, and set `ownerUserId` explicitly if more than one user is allowed.
- Keep private tool mode off unless you need it.
- Group-wide `allowAllBotUsers` can create loops. Use it temporarily or with a strict `maxConsecutiveBotMessages`.
- Do not set `toolWritableRoots` to your home directory or filesystem root.
- `liveLogEnabled` writes plaintext chat content to disk. It is off by default for a reason.
- `desktopSync` writes into Codex's own state database. Leave it off unless you want the sidebar row.

## Troubleshooting

- No group messages arrive: disable Privacy Mode in BotFather.
- Bot cannot see other bots: enable Bot to Bot Communication Mode in BotFather.
- Bot ignores a group: add the group ID to `allowedGroups`, or send `/<prefix>_on` in the group.
- Bot replies too often: turn on `requireMention` or lower `maxConsecutiveBotMessages`.
- Images are ignored: make sure Telegram sends them as `photo` or image documents under `imageMaxBytes`.
- Files are ignored: make sure they are under `fileMaxBytes`; if a file has no text preview, check whether its format is binary or unsupported.
- Private tool work does not happen: check `/tools`, confirm `privateToolsEnabled: true`, and make sure the target path is inside `toolWritableRoots`.
- The terminal window says read-only: you attached without `-s workspace-write --add-dir`. See [step 3 above](#3-add-a-shortcut-command-for-the-terminal-window).
- The bot answers in Telegram but the terminal shows nothing: you are still in spawn mode, or the TUI resumed a different thread id than `.state/session.txt`.
- The bridge starts but refuses every message with a thread error: the locked thread could not be resumed. This is deliberate — it never silently creates a replacement thread, because that reads as amnesia. Use `/resume <thread-id>` or `/new`.

## License

MIT
