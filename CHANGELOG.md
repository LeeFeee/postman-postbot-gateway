# Changelog / 更新记录

本文件记录每次发布和推送包含的功能、修复与验证结果。

This file records the features, fixes, and verification included in each release and push.

## 0.2.9 — 2026-08-20

### 中文

- 识别 Postman 仅返回 `usageState=BLOCKED`、不返回模型文本的情况，明确返回 HTTP 429 用量错误。
- 错误中显示团队共享状态、当前用量、额度上限和 `blockedUntil`，并提供 Postman AI 设置入口。
- 避免将用量阻止误报为 Auto mode XML 或 Goal Hook JSON 格式错误，也避免流式请求显示为空回复。
- 保留上游 HTTP 429 状态及 `http-rate-limit` 错误码，区分短时限流和周期用量阻止。
- 调试模式记录 SSE 事件类型、用量状态及无效模型输出片段，便于定位新版 Postman 协议问题。

### English

- Detect Postman streams that contain only `usageState=BLOCKED` and no model output, returning an explicit HTTP 429 usage error.
- Include pooled-team status, current usage, limit, and `blockedUntil`, with a link to Postman AI settings.
- Prevent usage blocks from being misreported as Auto mode XML or Goal Hook JSON failures, and prevent blank streaming replies.
- Preserve upstream HTTP 429 status and the `http-rate-limit` code to distinguish transient rate limiting from cycle usage blocks.
- Log SSE event types, usage state, and invalid model-output snippets in debug mode for Postman protocol diagnostics.

## 0.2.8 — 2026-08-20

### 中文

- Auto mode 首次回复缺少 XML 判定时，沿用已经建立的 Postman `conversationId` 做一次短指令格式纠正。
- 纠正请求不重放超长动作、系统提示或客户端工具，避免再次触发输入截断与身份偏移。
- 第二次仍不符合 Claude Code XML 协议时继续失败关闭，不会默认批准。
- 识别 Postman 12.24.2 的 `consent=false` 事件，建议用户前往 Postman 后台检查 AI 开启状态，并提供对应设置入口，不将单一信号断言为唯一根因。
- 调试模式保留脱敏后的 Postman `failure` 事件内容，并支持提取嵌套错误详情。

### English

- When the first Auto mode reply lacks an XML verdict, retry once in the established Postman `conversationId` with a short format-repair turn.
- The repair turn does not replay the oversized action, system prompt, or client tools, avoiding another truncation or persona drift.
- If the repaired reply is still invalid, the gateway remains fail-closed and never defaults to approval.
- Recognize Postman 12.24.2 `consent=false` events and direct users to the Postman AI settings page for verification without asserting a single root cause.
- Preserve sanitized Postman `failure` event data in debug mode and extract nested error details.

## 0.2.7 — 2026-08-19

### 中文

#### 新增

- 支持 Anthropic `output_config.format=json_schema` 与 `output_format` 结构化输出。
- 支持 Claude Code `/goal` Stop Hook 所需的 JSON Schema 判定。
- 增加轻量 JSON Schema 校验、JSON 提取和目标完成判定文本纠正。
- 为流式 Anthropic 结构化请求增加缓冲、验证和标准 SSE 输出。

#### 修复

- 超长系统提示改为同时保留开头和末尾，避免截掉 Auto mode 的 XML 输出协议。
- 自动识别 Claude Code Auto mode 安全分类请求，并在动作末尾追加 XML-only 响应契约。
- 从 Postman 的额外解释中提取并净化 `<block>`、`<category>` 和 `<reason>` 标签。
- 无法解析分类结果时保持失败关闭，不会默认批准工具调用。
- 避免 Postman 助手身份回复覆盖复杂 Bash 或 Agent 操作的安全分类结果。

#### 验证

- 自动化测试：27 项全部通过。
- 真实验证 Claude Code 2.1.229 `/goal` 结构化 Stop Hook。
- 真实复放复杂 Bash Auto mode 分类；Sonnet 与 GPT-5.6 Sol 均返回 `<block>no</block>`。

### English

#### Added

- Anthropic `output_config.format=json_schema` and `output_format` structured-output support.
- JSON Schema verdicts required by Claude Code `/goal` Stop Hooks.
- Lightweight JSON Schema validation, JSON extraction, and goal-verdict prose coercion.
- Buffered validation and standard SSE output for streaming Anthropic structured requests.

#### Fixed

- Oversized system prompts now retain both their beginning and ending, preserving Auto mode's XML output contract.
- Claude Code Auto mode classifier requests are detected and receive a final XML-only response contract.
- `<block>`, `<category>`, and `<reason>` tags are extracted from surrounding Postman prose and normalized.
- Unparseable classifier responses fail closed and never default to approval.
- Postman's assistant persona no longer replaces safety verdicts for complex Bash or Agent actions.

#### Verified

- All 27 automated tests pass.
- Claude Code 2.1.229 `/goal` structured Stop Hook verified against the real gateway.
- Complex Bash Auto mode replay verified with both Sonnet and GPT-5.6 Sol returning `<block>no</block>`.
