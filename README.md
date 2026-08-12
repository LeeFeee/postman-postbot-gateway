# Postman Postbot Gateway

[中文](#中文) · [English](#english)

> [!WARNING]
> This is an unofficial experimental project. It uses an undocumented endpoint used by the Postman desktop app. The endpoint, payload, authentication flow, and availability may change without notice. This project is not affiliated with or endorsed by Postman, OpenAI, or Anthropic.

## 中文

Postman Postbot Gateway 是一个零依赖的 Node.js 本地网关。它读取本机 Postman 桌面客户端的登录信息，将 Postman Agent/Postbot 的真实响应转换成 OpenAI Chat Completions 和 Anthropic Messages 兼容格式。

### 功能

- 向 Postman 的真实 Agent Chat 服务发送请求，不返回模拟文本
- 自动读取 macOS、Windows 和 Linux 上的 Postman 登录信息
- 尝试从 Postman 客户端日志中自动识别最近使用的工作区
- 从 Postman 配置接口动态获取账号实际可用的模型
- 支持 OpenAI `/v1/chat/completions`
- 支持 Anthropic `/v1/messages`
- 支持两种协议的 SSE 流式输出
- 支持 Anthropic `/v1/messages/count_tokens` 的兼容响应
- 默认只监听 `127.0.0.1`
- 不在日志中打印 Postman 登录令牌

### 已知限制

- 使用的是 Postman 桌面客户端未公开的内部接口，Postman 更新后可能失效。
- 当前只转换文本内容，不支持 `tool_use` / `tool_result`。Claude Code 可以进行文本对话，但无法通过此网关调用本地文件、Shell 等工具。
- 不支持 OpenAI Responses API `/v1/responses`，因此当前不能直接用于 Codex CLI。
- 图片会被替换成文字占位符，不会发送到 Postman。
- 每次兼容 API 请求都会创建一个新的 Postman 会话。
- 使用量和可用模型由你的 Postman 账号、团队方案和管理员策略决定。

### 环境要求

- Node.js 20 或更高版本
- 已安装 Postman 桌面客户端
- 已在 Postman 中登录
- 账号已获得 Postman Agent/Postbot 使用权限

目前已在以下环境验证：

- macOS Apple Silicon
- Postman 12.23.1
- Node.js 22
- Claude Code 2.1.226

### 安装

```bash
git clone https://github.com/leefeee/postman-postbot-gateway.git
cd postman-postbot-gateway
npm run check
```

本项目没有第三方运行时依赖，不需要执行 `npm install`。

### 启动

```bash
npm start
```

默认监听：

```text
http://127.0.0.1:9887
```

查看帮助：

```bash
node postman-gateway-macos.js --help
```

如果无法自动识别工作区，可以手动指定：

```bash
node postman-gateway-macos.js \
  --workspace-id "YOUR_POSTMAN_WORKSPACE_UUID"
```

### 配置选项

| 命令行选项 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `--port`, `-p` | `PORT` | `9887` | 本地监听端口 |
| `--host`, `-H` | `HOST` | `127.0.0.1` | 绑定地址 |
| `--postman-data-dir`, `-d` | `POSTMAN_DATA_DIR` | 系统默认目录 | Postman 用户数据目录 |
| `--workspace-id`, `-w` | `POSTMAN_WORKSPACE_ID` | 自动识别 | Postman 工作区 UUID |
| — | `POSTMAN_APP_VERSION` | 本地版本 | 覆盖 Postman 客户端版本 |
| — | `POSTMAN_GATEWAY_URL` | `https://gateway.postman.com` | 上游地址，仅用于调试 |

Postman 默认数据目录：

- macOS：`~/Library/Application Support/Postman`
- Windows：`%APPDATA%\Postman`
- Linux：`${XDG_CONFIG_HOME:-~/.config}/Postman`

### API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/` | 健康状态 |
| `GET` | `/v1/models` | 账号实际可用模型与使用量 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions 兼容接口 |
| `POST` | `/v1/messages` | Anthropic Messages 兼容接口 |
| `POST` | `/v1/messages/count_tokens` | 估算输入 token 数 |

查看模型：

```bash
curl http://127.0.0.1:9887/v1/models
```

OpenAI 格式：

```bash
curl http://127.0.0.1:9887/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "postbot",
    "messages": [
      {"role": "user", "content": "只回复 OK"}
    ]
  }'
```

OpenAI 流式格式：

```bash
curl -N http://127.0.0.1:9887/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "postbot",
    "stream": true,
    "messages": [
      {"role": "user", "content": "只回复 OK"}
    ]
  }'
```

Anthropic 格式：

```bash
curl http://127.0.0.1:9887/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "postbot",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "只回复 OK"}
    ]
  }'
```

`postbot`、`default` 和 `auto` 会使用 Postman 返回的默认模型。也可以先查询 `/v1/models`，再传入真实模型 key 或显示名称。

### Claude Code

建议先使用一次性配置，避免覆盖现有设置：

```bash
claude \
  --model postbot \
  --settings '{
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:9887",
      "ANTHROPIC_AUTH_TOKEN": "local-postman-gateway",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
  }'
```

`ANTHROPIC_AUTH_TOKEN` 可以填写任意非空字符串；本地网关不会使用它。真正的上游认证信息从 Postman 本地数据中读取。

### 安全说明

- 只在你拥有或获准使用的 Postman 账号上运行。
- 保持默认的 `127.0.0.1`，不要将网关直接暴露到局域网或公网。
- 不要提交 Postman 的 `userPartitionData.json`、令牌、日志或完整用户数据目录。
- 本地兼容接口目前不校验传入的 API Key；同一台机器上的其他进程可能调用它。
- Postman 令牌通常拥有比 AI 对话更广的账号权限，请像对待密码一样保护它。
- 使用本项目之前，请自行确认符合 Postman 的服务条款、团队政策及适用法律。

### 工作原理

```text
OpenAI / Anthropic 客户端
            │
            ▼
  127.0.0.1:9887 本地网关
            │
            ├── 读取本机 Postman 登录信息
            ├── 将请求转换为 Postman Agent Chat 格式
            └── 将 Postman SSE 转换回兼容协议
            │
            ▼
   gateway.postman.com/chat
```

### License

[MIT](LICENSE)
---

## English

Postman Postbot Gateway is a zero-dependency local Node.js gateway. It reads the signed-in Postman desktop session, sends requests to Postman's real Agent/Postbot service, and converts the responses into OpenAI Chat Completions and Anthropic Messages compatible formats.

### Features

- Sends real requests to Postman Agent Chat instead of returning mock text
- Reads Postman desktop session data on macOS, Windows, and Linux
- Attempts to detect the most recently used Postman workspace from local logs
- Fetches the models actually available to the signed-in Postman account
- Supports OpenAI `/v1/chat/completions`
- Supports Anthropic `/v1/messages`
- Supports SSE streaming for both compatibility APIs
- Provides an Anthropic-compatible `/v1/messages/count_tokens` response
- Binds to `127.0.0.1` by default
- Never prints the Postman access token to logs

### Known limitations

- This project relies on an undocumented Postman desktop endpoint and may stop working after an update.
- Only text responses are translated. `tool_use` and `tool_result` are not supported. Claude Code can chat through the gateway, but it cannot use local filesystem or shell tools through it.
- The OpenAI Responses API `/v1/responses` is not implemented, so Codex CLI is not currently supported.
- Image inputs are replaced with a text placeholder and are not forwarded.
- Each compatibility request creates a new Postman conversation.
- Available models and usage limits depend on the Postman account, team plan, and administrator policy.

### Requirements

- Node.js 20 or newer
- Postman desktop installed
- A signed-in Postman account
- Access to Postman Agent/Postbot on that account

Tested with macOS on Apple Silicon, Postman 12.23.1, Node.js 22, and Claude Code 2.1.226.

### Installation

```bash
git clone https://github.com/leefeee/postman-postbot-gateway.git
cd postman-postbot-gateway
npm run check
```

There are no third-party runtime dependencies, so `npm install` is not required.

### Start the gateway

```bash
npm start
```

The default address is:

```text
http://127.0.0.1:9887
```

Show all options:

```bash
node postman-gateway-macos.js --help
```

If workspace detection fails, specify it explicitly:

```bash
node postman-gateway-macos.js \
  --workspace-id "YOUR_POSTMAN_WORKSPACE_UUID"
```

### Configuration

| CLI option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--port`, `-p` | `PORT` | `9887` | Local listening port |
| `--host`, `-H` | `HOST` | `127.0.0.1` | Bind address |
| `--postman-data-dir`, `-d` | `POSTMAN_DATA_DIR` | OS default | Postman user data directory |
| `--workspace-id`, `-w` | `POSTMAN_WORKSPACE_ID` | Auto-detected | Postman workspace UUID |
| — | `POSTMAN_APP_VERSION` | Local version | Override the Postman app version |
| — | `POSTMAN_GATEWAY_URL` | `https://gateway.postman.com` | Upstream URL for debugging only |

Default Postman data directories:

- macOS: `~/Library/Application Support/Postman`
- Windows: `%APPDATA%\Postman`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/Postman`

### API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Health status |
| `GET` | `/v1/models` | Available models and account usage |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions compatibility |
| `POST` | `/v1/messages` | Anthropic Messages compatibility |
| `POST` | `/v1/messages/count_tokens` | Estimated input token count |

List models:

```bash
curl http://127.0.0.1:9887/v1/models
```

OpenAI-compatible request:

```bash
curl http://127.0.0.1:9887/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "postbot",
    "messages": [
      {"role": "user", "content": "Reply with OK only"}
    ]
  }'
```

OpenAI-compatible streaming request:

```bash
curl -N http://127.0.0.1:9887/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "postbot",
    "stream": true,
    "messages": [
      {"role": "user", "content": "Reply with OK only"}
    ]
  }'
```

Anthropic-compatible request:

```bash
curl http://127.0.0.1:9887/v1/messages \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "postbot",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Reply with OK only"}
    ]
  }'
```

`postbot`, `default`, and `auto` use the default model returned by Postman. Query `/v1/models` to use a specific real model key or display name.

### Claude Code

Use a one-off settings override first so your existing configuration stays untouched:

```bash
claude \
  --model postbot \
  --settings '{
    "env": {
      "ANTHROPIC_BASE_URL": "http://127.0.0.1:9887",
      "ANTHROPIC_AUTH_TOKEN": "local-postman-gateway",
      "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
    }
  }'
```

`ANTHROPIC_AUTH_TOKEN` may contain any non-empty value. The local gateway ignores it and reads the real upstream session from the Postman desktop data directory.

### Security

- Run this project only with a Postman account you own or are authorized to use.
- Keep the default `127.0.0.1` bind address. Do not expose the gateway directly to a LAN or the public internet.
- Never commit `userPartitionData.json`, Postman tokens, logs, or the complete Postman user data directory.
- The compatibility endpoints do not validate incoming API keys. Other processes on the same machine may be able to call the gateway.
- A Postman desktop token may grant permissions beyond AI chat. Protect it like a password.
- Before use, make sure the project complies with Postman's terms, your organization policies, and applicable law.

### How it works

```text
OpenAI / Anthropic client
           │
           ▼
  Local gateway on 127.0.0.1:9887
           │
           ├── reads the local Postman desktop session
           ├── converts requests to Postman Agent Chat
           └── converts Postman SSE back to a compatible protocol
           │
           ▼
   gateway.postman.com/chat
```

### License

[MIT](LICENSE)
