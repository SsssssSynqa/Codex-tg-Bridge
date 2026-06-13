# Telegram Codex Bridge

一个零依赖的 Telegram Bot API 桥接器，用来把 Telegram bot 接到持久运行的 `codex app-server` 会话。

它支持私聊、群聊、仅 @ 触发、@ 时读取最近群聊上下文、群聊批量合并回复、bot 接龙防循环、发送限速、Telegram 图片附件、普通文件附件文本预览、可选的私聊工具执行，以及由 `AGENTS.md` 承载稳定规则的短 Telegram payload 协议。

English documentation: [README.md](README.md).

## 这是什么

Telegram Codex Bridge 可以把 Telegram bot 作为一个轻量入口，连接到持续运行的 Codex 会话。它适合个人自动化、小范围可信群聊，以及需要从 Telegram 调用 Codex 的 bot-to-bot 工作流。

## 运行要求

- macOS、Linux，或其他能运行 Node.js 的机器
- Node.js 20+
- 从 [@BotFather](https://t.me/BotFather) 获取的 Telegram bot token
- 同一台机器上已经安装并登录 Codex
- Telegram bot 必须能收到你希望它处理的消息：
  - 如果要读取群里所有消息，需要在 BotFather 里关闭 Privacy Mode。
  - 如果要让其他 bot 触发它，需要启用 bot-to-bot communication。

## 快速开始

```bash
git clone https://github.com/SsssssSynqa/Codex-tg-Bridge.git
cd Codex-tg-Bridge
cp .env.example .env
cp config.example.json config.json
```

编辑 `.env`：

```bash
TELEGRAM_BOT_TOKEN=1234567890:your-real-token
```

编辑 `config.json`：

- 把 `allowedUserIds` 改成你的 Telegram 数字 user ID。
- 把 `workdir` 改成 Codex 要运行的工作目录。
- 如果需要群聊，在 `allowedGroups` 里加入群 ID。
- 在理解安全模型之前，保持 `privateToolsEnabled: false`。

把 `AGENTS.example.md` 里的协议复制到你配置的 `workdir` 对应的 `AGENTS.md`。长人格规则、隐私规则、群 profile 都应该放在那里。不要把长行为 prompt 塞进 `config.json`；桥接器每轮只发送很短的模式标记和动态 Telegram payload。

运行：

```bash
npm run check
npm start
```

在 Telegram 私聊 bot 发送 `/start`。如果你的 user ID 已授权，它会回复。

## Telegram 命令

私聊命令：

- `/start`：确认桥接在线。
- `/status`：查看桥接状态、当前 session 和群数量。
- `/session`：查看当前 Codex thread ID。
- `/resume <thread-id>` 或 `/attach <thread-id>`：切换到已有 Codex thread。
- `/tools`：查看私聊工具模式、可写目录、网络权限，以及群聊只读规则。
- `/new`：开启新 Codex session，并在本地保留旧 session ID。

## 获取 Telegram ID

把 [@getidsbot](https://t.me/getidsbot) 拉进聊天，然后使用它输出的信息：

- 你的私聊 user ID 填到 `allowedUserIds`。
- 群 ID 填到 `allowedGroups`。
- 如果希望特定 bot 触发你的 bot，可以把 bot ID 填进对应群的 `allowedUserIds`。

群 ID 通常长得像 `-1001234567890`。

## 配置

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
      "profile": "default-group",
      "batchTiming": {
        "singleMessageMs": 3000,
        "sameSenderIdleMs": 2500,
        "sameSenderMaxMs": 8000,
        "multiSenderIdleMs": 4000,
        "multiSenderMaxMs": 12000
      }
    }
  },
  "workdir": "/absolute/path/to/your/codex/workspace",
  "privateToolsEnabled": false,
  "toolWritableRoots": ["/absolute/path/to/your/codex/workspace"],
  "toolNetworkAccess": false
}
```

重要顶层选项：

- `botName`：写入短 Telegram payload 的 bot 名称。
- `ownerName`：写入短 Telegram payload 的私聊用户称呼。
- `workdir`：Codex 工作目录。
- `model`：Codex 模型，默认 `gpt-5.5`。
- `reasoningEffort`：推理强度，默认 `medium`。
- `serviceTier`：app-server service tier 覆盖值，默认 `fast`。
- `privateToolsEnabled`：设为 `true` 时，私聊可以在受限 workspace-write 模式下使用 Codex 工具。
- `toolWritableRoots`：私聊工具模式允许写入的目录，支持绝对路径或相对配置文件的路径。
- `toolNetworkAccess`：私聊工具模式是否允许网络访问，默认 `false`。

重要群聊选项：

- `requireMention`：为 `true` 时，群消息必须 @ bot 或回复 bot 才触发。
- `allowAllHumanUsers`：为 `true` 时，该群所有真人都能触发。
- `allowAllBotUsers`：为 `true` 时，该群所有 bot 都能触发。谨慎使用。
- `allowUnaddressedBotMessages`：允许已授权 bot 不 @ 也触发。
- `maxConsecutiveBotMessages`：限制连续 bot 接龙，防止循环。
- `mentionContext`：被 @ 或回复时，读取最近群消息作为只读上下文。
- `profile`：短 profile key，会写入 payload；在 `AGENTS.md` 里用它选择对应群规则。
- `batchTiming`：可选的单群消息收集窗口覆盖值。高频游戏/闲聊群建议设置更长窗口，减少模型调用。

`promptInstructions` 已不推荐也不会作为长规则注入。群专属行为、语气和隐私规则应该写进 `AGENTS.md`，不要每条消息重复发送。

## 私聊工具模式

默认情况下桥接是只读的。只有当你确实希望 Telegram 私聊能执行本地 Codex 工作时，才把 `privateToolsEnabled` 设为 `true`。

开启后：

- 私聊使用受限 `workspaceWrite` sandbox。
- 写入范围限制在 `toolWritableRoots`。
- 默认不允许网络访问，除非 `toolNetworkAccess: true`。
- 群聊每一轮仍然强制只读。
- 桥接器会自动拒绝这些审批请求：越出可写根、请求网络权限、命令文本里包含 token 形态、递归删除、hard reset、force push、大范围权限修改、磁盘操作、破坏性 `launchctl` 操作等。

这仍然是一个远程控制入口。请严格限制 `allowedUserIds`，保护 bot token，不要给共享账号开启工具模式。

## Prompt 协议和作用域隔离

桥接默认使用同一个持久 Codex thread，因此私聊和群聊可能共享历史。为了减少风格和隐私规则串味：

- 稳定 Telegram 规则放在工作区 `AGENTS.md`；可以从 `AGENTS.example.md` 开始。
- 每轮 bridge prompt 都尽量短，只包含 `TG_PRIVATE`、`TG_GROUP_BATCH` 之类的模式标记，以及当前 Telegram 消息的 JSON payload。
- 群 profile 应写在 `AGENTS.md` 里，并由 `config.json` 里的短 `profile` key 选择。
- 即使私聊工具模式开启，群聊也始终只读。

如果你需要更强隔离，请为不同场景运行不同桥接实例或使用不同 session。

## 仅 @ 触发和最近上下文

在安静群里，可以保持 `requireMention: true`。普通群消息不会触发回复，但桥接器可以把 Telegram 实际投递给它的最近消息保存在内存里。当有人 @ bot 或回复 bot 时，prompt 会带上最近消息，帮助 Codex 理解“上面那个”等引用。

默认 `mentionContext.messageCount` 是 `10`。这段历史只保存在内存里，不写入磁盘。

Telegram 限制：bot 只能记住 Telegram 实际投递给它的消息。如果 BotFather Privacy Mode 开着，普通群消息可能根本不会送到桥接器。需要 @ 时读取最近上下文的群，请关闭 Privacy Mode。

## 附件

Telegram `photo` 消息和图片文档会下载到 `telegram-images/`，并作为 `localImage` 输入传给 Codex。

普通 Telegram 文件会下载到 `telegram-files/`。桥接器会把文件元数据、本地路径和可抽取的文本预览写进 prompt。

常见文本、代码、数据文件会直接抽取预览，例如 `.txt`、`.md`、`.json`、`.csv`、`.html`、`.js`、`.ts`、`.py`、`.yaml` 等。在 macOS 上，`.doc`、`.docx`、`.rtf`、`.odt` 会尝试用 `textutil` 转换。二进制或不支持的文件仍会下载，但 prompt 只包含元数据和路径，并明确要求 Codex 不要假装已经读完正文。

附件缓存已被 `.gitignore` 忽略。默认跳过超过 10 MB 的图片和超过 20 MB 的普通文件。

## Token 轮换

如果 bot token 被粘贴进聊天、issue、日志或其他不安全位置，请立刻轮换：

1. 打开 [@BotFather](https://t.me/BotFather)。
2. 使用 `/revoke` 或 BotFather 的 token 管理流程生成新 token。
3. 替换 `.env` 里的 `TELEGRAM_BOT_TOKEN`。
4. 重启桥接器。

不要提交 `.env`。

## macOS LaunchAgent

仓库包含 LaunchAgent 模板：`launchd/com.example.telegram-codex-bridge.plist`。

先编辑路径，再安装：

```bash
cp launchd/com.example.telegram-codex-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.telegram-codex-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.example.telegram-codex-bridge
```

查看状态：

```bash
launchctl print gui/$(id -u)/com.example.telegram-codex-bridge
```

## 安全注意事项

- 不要提交 `.env`、`config.json`、session 文件、offset、日志、下载图片或下载文件。
- 严格限制 `allowedUserIds`。
- 不需要时保持私聊工具模式关闭。
- `allowAllBotUsers` 容易造成 bot 循环，只建议临时使用，并配合严格的 `maxConsecutiveBotMessages`。
- 不要把 `toolWritableRoots` 设成 home 目录或文件系统根目录。

## 常见问题

- 群消息收不到：关闭 BotFather Privacy Mode。
- 看不到其他 bot：开启 Bot to Bot Communication Mode。
- 某个群被忽略：把群 ID 加到 `allowedGroups`。
- 回复太频繁：开启 `requireMention` 或降低 `maxConsecutiveBotMessages`。
- 图片被忽略：确认 Telegram 发送的是 `photo` 或图片文档，且大小不超过 `imageMaxBytes`。
- 文件被忽略：确认文件大小不超过 `fileMaxBytes`；如果没有文本预览，检查格式是否是二进制或暂不支持。
- 私聊工具不执行：发送 `/tools` 检查状态，确认 `privateToolsEnabled: true`，目标路径在 `toolWritableRoots` 内。

## License

MIT
