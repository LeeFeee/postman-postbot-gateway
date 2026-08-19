# Postman Postbot Gateway

[中文](#中文) · [English](#english)

> [!WARNING]
> This is an unofficial experimental project. It uses an undocumented endpoint used by the Postman desktop app. The endpoint, payload, authentication flow, and availability may change without notice. This project is not affiliated with or endorsed by Postman, OpenAI, or Anthropic.

## 中文

Postman Postbot Gateway 是一个零第三方依赖的 Node.js 本地网关。它读取本机 Postman 桌面端登录会话，把 Postman Agent 的真实响应转换成 Claude Code、Codex CLI 和 Trae 可以使用的 API 协议。

### 功能

- 真实转发到 `gateway.postman.com/chat`，不返回模拟文本
- 支持 Anthropic Messages `/v1/messages`，可接入 Claude Code
- 兼容 Anthropic `output_config.format=json_schema`，支持 Claude Code `/goal` Stop Hook 等结构化判定
- 对超长系统提示同时保留开头和末尾输出契约，兼容 Claude Code Auto mode 的 XML 安全分类器
- 在复杂命令末尾强化 Auto mode XML 契约并净化响应，避免 Postman 助手身份覆盖安全判定
- 支持 OpenAI Responses `/v1/responses`，可接入 Codex CLI
- 支持 OpenAI Chat Completions `/v1/chat/completions`，可接入 Trae 等客户端
- 转换 Anthropic `tool_use` / `tool_result`
- 转换 OpenAI `tool_calls` / `role=tool`
- 转换 Responses `function_call` / `function_call_output`
- 将客户端工具动态注入 Postman Agent，再把工具结果作为分组 `toolResponse` 回传
- 审批由 Claude Code、Codex 或 Trae 自己处理；拒绝结果会转换为 Postman `REJECTED / EXPLICIT`
- 保存并复用 Postman `conversationId`，客户端后续只向 Postman发送增量消息
- 避免把客户端完整历史反复拼入 Postman `query`，解决首次对话的 `Chat input too large`
- 区分当前轮和历史工具结果，避免下一次普通提问重复提交旧 `tool_result`
- 支持普通响应和 SSE 流式响应
- 自动读取 Postman 登录信息、工作区和账号实际可用模型
- 默认只监听 `127.0.0.1`，日志不输出令牌和完整提示词

### 已验证环境

- macOS Apple Silicon
- Postman 12.23.1
- Node.js 22
- Claude Code 2.1.229：首次完整系统提示、文本对话、Bash 工具调用、结果回传与 `/goal` 结构化 Stop Hook
- Claude Code 2.1.229 Auto mode：安全分类器 XML 判定、计划文件写入审批
- Codex CLI 0.147.0：Responses API、shell 工具调用与结果回传
- OpenAI Chat Completions：文本、工具调用、工具成功/失败/拒绝回传
- Trae SOLO Agent：真实 `Skill`、`Read` 工具连续调用与最终文本回复

Trae SOLO Agent 会在云端协调工具执行，并可能重写模型返回的 `tool_call_id`。网关会使用会话指纹、工具名和规范化参数进行严格匹配，再映射回 Postman 的原始工具调用 ID，保证工具结果能够继续同一个 Postman 会话。不同 Trae 版本的模型配置界面可能略有差异。

Postman Agent 偶尔会用自己的内部工具包装客户端工具，例如 `executeNamespaceTool`、`executeBashCommand`、`readFile`、`createFile`、`searchInFiles`、`listDirectory` 或命名空间查询工具。网关会把这些调用还原为客户端实际提供的 `Skill`、`Bash`、`Grep`、`Read` 和 `Write`；`searchInFiles` 在没有 `Grep` 时会安全降级为 `Bash + rg`。网关还会清理 Claude Code 不接受的空 `pages` 参数。Claude Code 的 Agent 调用如果携带可选的 worktree 隔离，网关也会移除该参数，避免在非 Git 目录中启动失败。

### 工作原理

```text
Claude Code / Codex CLI / Trae
             │
             ▼
   127.0.0.1:9887 本地网关
             │
             ├── 识别客户端会话和最新增量消息
             ├── 把客户端工具定义注入 Postman Agent
             ├── 保存 conversationId 与工具调用组
             └── 转换工具调用、审批结果和 toolResponse
             │
             ▼
    gateway.postman.com/chat
```

模型需要工具时，网关不会替客户端执行工具。它把工具调用返回给 Claude Code、Codex 或 Trae，由客户端显示审批并在本机执行；随后网关把执行结果连同原来的 `conversationId`、`toolCallGroupId` 和 `toolCallId` 发回 Postman，让 Agent 继续回答。

### 安装

```bash
git clone https://github.com/leefeee/postman-postbot-gateway.git
cd postman-postbot-gateway
npm test
```

项目没有第三方运行时依赖，不需要执行 `npm install`。要求 Node.js 20 或更高版本，并且 Postman 桌面端已经登录且有 Agent/Postbot 权限。

### 启动

```bash
npm start
```

默认地址：

```text
http://127.0.0.1:9887
```

如果无法自动识别工作区：

```bash
node postman-gateway-macos.js \
  --workspace-id "YOUR_POSTMAN_WORKSPACE_UUID"
```

健康检查：

```bash
curl http://127.0.0.1:9887/
```

返回结果中的 `capabilities` 应显示会话、工具调用、toolResponse 和三种客户端协议均为 `true`。

### 配置选项

| 命令行选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port`, `-p` | `PORT` | `9887` | 本地监听端口 |
| `--host`, `-H` | `HOST` | `127.0.0.1` | 绑定地址 |
| `--postman-data-dir`, `-d` | `POSTMAN_DATA_DIR` | 系统默认目录 | Postman 用户数据目录 |
| `--workspace-id`, `-w` | `POSTMAN_WORKSPACE_ID` | 自动识别 | Postman 工作区 UUID |
| — | `POSTMAN_APP_VERSION` | 本地版本 | 覆盖 Postman 版本 |
| — | `POSTMAN_GATEWAY_URL` | `https://gateway.postman.com` | 调试用上游地址 |
| — | `POSTMAN_GATEWAY_STATE_FILE` | `~/.postman-postbot-gateway/sessions.json` | 会话映射缓存 |
| — | `POSTMAN_SESSION_TTL_MS` | `43200000` | 会话缓存有效期，默认 12 小时 |
| — | `POSTMAN_MAX_QUERY_CHARS` | `9800` | Postman 单次 `query` 安全上限 |
| — | `POSTMAN_GATEWAY_DEBUG` | `0` | 设为 `1` 输出协议诊断日志 |
| — | `POSTMAN_CLIENT_TOOLS_HASH` | 自动 | Postman 更新后手动覆盖工具版本哈希 |
| — | `POSTMAN_KB_TERMS_HASH` | 自动 | Postman 更新后手动覆盖知识条目哈希 |

Postman 默认数据目录：

- macOS：`~/Library/Application Support/Postman`
- Windows：`%APPDATA%\Postman`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/Postman`

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 健康状态与能力列表 |
| `GET` | `/v1/models` | 可用模型与账号用量 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions / Trae |
| `POST` | `/v1/messages` | Anthropic Messages / Claude Code |
| `POST` | `/v1/messages/count_tokens` | Anthropic Token Count |
| `POST` | `/v1/responses` | OpenAI Responses / Codex CLI |

查询模型：

```bash
curl http://127.0.0.1:9887/v1/models
```

`postbot`、`default` 和 `auto` 会使用 Postman 的默认模型。也可以传入接口返回的真实模型 key 或显示名称。

### Claude Code 配置

先用一次性配置测试：

```bash
claude \
  --model postbot \
  --settings '{
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:9887",
      "ANTHROPIC_API_KEY": "local-postman-gateway",
      "ANTHROPIC_AUTH_TOKEN": "local-postman-gateway",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
  }'
```

注意：Claude Code 的 `ANTHROPIC_BASE_URL` 必须是 `http://127.0.0.1:9887`，末尾不要加 `/v1`。本地 API Key 可以填写任意非空字符串，网关真正使用的是 Postman 桌面端会话。

长期使用时，把上面的 `env` 合并到 `~/.claude/settings.json`，启动时使用：

```bash
claude --model postbot
```

Claude Code 收到 `tool_use` 后仍会遵守自己的 permission mode、`allowedTools` 和 `disallowedTools`。网关不会绕过审批。

### Codex CLI 配置

在 `~/.codex/config.toml` 中加入：

```toml
model = "postbot"
model_provider = "postman"

[model_providers.postman]
name = "Postman Gateway"
base_url = "http://127.0.0.1:9887/v1"
env_key = "POSTMAN_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

再设置一个任意非空的本地占位 Key：

```bash
export POSTMAN_GATEWAY_API_KEY="local-postman-gateway"
codex
```

Codex 必须使用 Responses API，所以这里的 `base_url` 需要包含 `/v1`。Codex 的 sandbox 和 approval 配置继续生效，shell、文件修改等工具都由 Codex 本地执行。

### Trae 配置

在 Trae 的自定义模型中填写：

| 配置项 | 值 |
| --- | --- |
| API 格式 | OpenAI Chat Completions |
| 自定义请求地址 | `http://127.0.0.1:9887/v1` |
| 完整 URL | 关闭 |
| 模型 ID | `postbot`，或 `/v1/models` 返回的真实模型 |
| API 密钥 | 任意非空字符串 |

Trae 会自动在地址后补 `/chat/completions`。不要同时打开“完整 URL”并填写 `/v1`，否则可能拼出错误路径。

### 会话与输入上限

Postman `/chat` 的 `input.query` 存在约 10,000 字符的硬上限，这和模型上下文窗口不是一回事。旧版本把系统提示和完整历史全部拼进 `query`，因此 Claude Code 或 Trae 第一次只说“你好”也可能报错。

当前版本会：

1. 第一次请求只发送客户端系统提示和当前用户消息，并控制在安全上限内。
2. 保存 Postman 返回的 `conversationId`。
3. 后续请求只发送新增用户消息；Postman 通过服务端会话保留历史。
4. 工具结果通过 `TOOL_RESPONSE` 单独回传，不再塞回普通文本历史。
5. Claude Code、Codex 和 Trae 重放完整历史时，网关只处理当前轮尾部的新工具结果。
6. Trae 重写工具调用 ID 时，网关只在工具名、参数和会话指纹全部匹配后映射回 Postman 原始 ID。

如果单条用户消息本身超过安全上限，网关会保留尾部并明确标记截断。图片和文件二进制目前不会转发，只会生成文字占位符。

### 已知限制

- Postman Agent 接口、产品标识和客户端哈希都不是公开 API，Postman 更新后可能变化。
- Agent 工具模式目前在 macOS Postman 12.23.1 上完成真实验证；其他版本可通过两个哈希环境变量适配。
- 网关只注入调用方提供的工具，不会直接开放 Postman 桌面端内部工具。
- 图片和文件二进制输入尚未转发给 Postman。
- 会话缓存在本机且默认 12 小时过期；清除缓存或跨机器后，未完成的工具调用不能继续。
- 用量、模型和功能权限由 Postman 账号、团队方案及管理员策略决定。

### 安全说明

- 只在你拥有或获准使用的 Postman 账号上运行。
- 保持默认 `127.0.0.1`，不要直接暴露到局域网或公网。
- 不要提交 Postman 的 `userPartitionData.json`、令牌、日志或完整用户数据目录。
- 兼容接口不校验传入的占位 API Key，同一台机器上的其他进程可能调用网关。
- Postman 桌面端令牌可能拥有比 AI 对话更广的账号权限，请像密码一样保护。
- 使用前请自行确认符合 Postman 服务条款、团队政策和适用法律。

### 测试

```bash
npm run check
npm test
```

自动化测试覆盖输入上限、Anthropic JSON Schema 结构化输出、三种工具定义、三种工具结果、历史结果重放、并行结果、分组 toolResponse、拒绝审批和 Responses function call。

每次发布和推送的具体修改见 [CHANGELOG.md](CHANGELOG.md)。

### License

[MIT](LICENSE)

---

## English

Postman Postbot Gateway is a zero-third-party-dependency Node.js gateway. It reads the signed-in Postman desktop session and translates real Postman Agent responses into protocols understood by Claude Code, Codex CLI, and Trae.

### Features

- Real forwarding to `gateway.postman.com/chat`; no mock responses
- Anthropic Messages `/v1/messages` for Claude Code
- Anthropic `output_config.format=json_schema` compatibility for Claude Code `/goal` Stop Hooks and other structured checks
- Head-and-tail preservation for oversized system prompts, including Claude Code Auto mode's XML classifier contract
- A final Auto mode XML contract and response normalization for complex actions, preventing Postman's assistant persona from replacing the safety verdict
- OpenAI Responses `/v1/responses` for Codex CLI
- OpenAI Chat Completions `/v1/chat/completions` for Trae and compatible clients
- Anthropic `tool_use` / `tool_result` translation
- OpenAI `tool_calls` / `role=tool` translation
- Responses `function_call` / `function_call_output` translation
- Dynamic injection of client tools into Postman Agent
- Grouped Postman `toolResponse` continuation with the original conversation and tool-call group
- Client-side approvals remain enforced; rejected calls become Postman `REJECTED / EXPLICIT` responses
- Persistent `conversationId` mapping and incremental user messages
- Avoids replaying the full client history into Postman's approximately 10,000-character `query` field
- Distinguishes current-turn tool outputs from historical outputs replayed by agent clients
- Non-streaming and SSE streaming responses
- Automatic Postman login, workspace, and model discovery
- Localhost-only binding by default; tokens and full prompts are never logged

### Verified environment

- macOS on Apple Silicon
- Postman 12.23.1
- Node.js 22
- Claude Code 2.1.229: full first-turn prompt, text, Bash call, tool-result continuation, and `/goal` structured Stop Hook
- Claude Code 2.1.229 Auto mode: XML safety classification and plan-file write approval
- Codex CLI 0.147.0: Responses API, local shell call, and tool-result continuation
- OpenAI Chat Completions: text, tool calls, successful, failed, and rejected tool results
- Trae SOLO Agent: live `Skill` and `Read` tool calls followed by the final text response

Trae SOLO Agent coordinates tool execution through its cloud service and may rewrite the model's `tool_call_id`. The gateway strictly matches the session fingerprint, tool name, and normalized arguments before mapping the result back to Postman's original tool call ID. Labels in Trae's model settings may vary by release.

Postman Agent may occasionally wrap client tools in internal names such as `executeNamespaceTool`, `executeBashCommand`, `readFile`, `createFile`, `searchInFiles`, `listDirectory`, or namespace-discovery helpers. The gateway translates them back to the client-provided `Skill`, `Bash`, `Grep`, `Read`, and `Write` tools; `searchInFiles` safely falls back to `Bash + rg` when `Grep` is unavailable. It also removes an empty `pages` field that Claude Code rejects and drops optional worktree isolation from Claude Code Agent calls so they can run outside a Git repository.

### Install and start

```bash
git clone https://github.com/leefeee/postman-postbot-gateway.git
cd postman-postbot-gateway
npm test
npm start
```

Node.js 20 or newer is required. Postman desktop must be installed, signed in, and authorized to use Agent/Postbot. No `npm install` is required.

The default address is `http://127.0.0.1:9887`. If workspace detection fails:

```bash
node postman-gateway-macos.js \
  --workspace-id "YOUR_POSTMAN_WORKSPACE_UUID"
```

### Configuration

| CLI option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--port`, `-p` | `PORT` | `9887` | Local port |
| `--host`, `-H` | `HOST` | `127.0.0.1` | Bind address |
| `--postman-data-dir`, `-d` | `POSTMAN_DATA_DIR` | OS default | Postman data directory |
| `--workspace-id`, `-w` | `POSTMAN_WORKSPACE_ID` | Auto-detected | Postman workspace UUID |
| — | `POSTMAN_GATEWAY_STATE_FILE` | `~/.postman-postbot-gateway/sessions.json` | Session mapping cache |
| — | `POSTMAN_SESSION_TTL_MS` | `43200000` | Session TTL, 12 hours |
| — | `POSTMAN_MAX_QUERY_CHARS` | `9800` | Safe Postman query limit |
| — | `POSTMAN_GATEWAY_DEBUG` | `0` | Protocol diagnostics when set to `1` |
| — | `POSTMAN_CLIENT_TOOLS_HASH` | Auto | Override after a Postman update |
| — | `POSTMAN_KB_TERMS_HASH` | Auto | Override after a Postman update |

Default Postman data directories:

- macOS: `~/Library/Application Support/Postman`
- Windows: `%APPDATA%\Postman`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Postman`

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Health and capabilities |
| `GET` | `/v1/models` | Available models and usage |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions / Trae |
| `POST` | `/v1/messages` | Anthropic Messages / Claude Code |
| `POST` | `/v1/messages/count_tokens` | Anthropic token estimate |
| `POST` | `/v1/responses` | OpenAI Responses / Codex CLI |

`postbot`, `default`, and `auto` select Postman's default model. Query `/v1/models` to use a real model key or display name.

### Claude Code

Test with a one-off override:

```bash
claude \
  --model postbot \
  --settings '{
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:9887",
      "ANTHROPIC_API_KEY": "local-postman-gateway",
      "ANTHROPIC_AUTH_TOKEN": "local-postman-gateway",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
  }'
```

Do not append `/v1` to `ANTHROPIC_BASE_URL`. The placeholder key may be any non-empty string. Claude Code still enforces its own permission mode and tool allow/deny rules.

### Codex CLI

Add this to `~/.codex/config.toml`:

```toml
model = "postbot"
model_provider = "postman"

[model_providers.postman]
name = "Postman Gateway"
base_url = "http://127.0.0.1:9887/v1"
env_key = "POSTMAN_GATEWAY_API_KEY"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
```

Then:

```bash
export POSTMAN_GATEWAY_API_KEY="local-postman-gateway"
codex
```

Codex requires the Responses wire API, so its `base_url` includes `/v1`. Codex remains responsible for sandboxing, approvals, and local tool execution.

### Trae

| Setting | Value |
| --- | --- |
| API format | OpenAI Chat Completions |
| Custom base URL | `http://127.0.0.1:9887/v1` |
| Full URL | Off |
| Model ID | `postbot` or a model returned by `/v1/models` |
| API key | Any non-empty string |

Trae appends `/chat/completions` automatically when Full URL is off.

### Conversation and tool flow

Postman's `/chat` endpoint limits `input.query` to approximately 10,000 characters. That is a request-field limit, not the model context window. The previous gateway replayed system instructions and the entire history into that field, so even a first “hello” from an agent client could fail.

The current gateway sends the first system instructions plus the current user turn within a safe limit, stores the returned `conversationId`, sends only new user turns afterward, and returns tool outputs through Postman's dedicated `TOOL_RESPONSE` contract. When a client replays its full history, only trailing tool outputs from the current turn are processed; completed historical outputs are ignored. If Trae rewrites a tool call ID, the gateway maps it back only when the session fingerprint, tool name, and normalized arguments all match.

Tools are never executed by the gateway. Claude Code, Codex, or Trae receives the call, applies its own approval policy, executes locally, and returns the result. The gateway then continues the same Postman conversation.

### Known limitations

- This relies on an undocumented Postman Agent API and private client metadata that may change.
- Agent tool mode has been verified on macOS with Postman 12.23.1. Other releases may require hash overrides.
- Only tools supplied by the calling client are injected; Postman's internal desktop tools are not exposed directly.
- Binary image and file inputs are currently represented by text placeholders.
- Session mappings expire after 12 hours by default. Pending tool calls cannot resume after their mapping is removed.
- Models, quotas, and features depend on the Postman account and organization policy.

### Security

- Use only a Postman account you own or are authorized to use.
- Keep the default `127.0.0.1` binding; do not expose this gateway directly to a LAN or the public internet.
- Never commit Postman session files, tokens, logs, or the entire data directory.
- Placeholder API keys are not validated by the gateway, so other local processes may call it.
- Treat the Postman desktop token like a password.
- Confirm compliance with Postman's terms, organization policies, and applicable law.

### Test

```bash
npm run check
npm test
```

See [CHANGELOG.md](CHANGELOG.md) for the exact changes included in each release and push.

### License

[MIT](LICENSE)
