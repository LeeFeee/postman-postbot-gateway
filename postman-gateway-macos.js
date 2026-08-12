#!/usr/bin/env node

'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const args = process.argv.slice(2);

function getArgValue(flag, shortFlag) {
  const index = args.findIndex((arg) => arg === flag || arg === shortFlag);
  return index !== -1 && args[index + 1] ? args[index + 1] : null;
}

const showHelp = args.includes('--help') || args.includes('-h') || args.includes('help');
const PORT = Number.parseInt(getArgValue('--port', '-p') || process.env.PORT || '9887', 10);
const HOST = getArgValue('--host', '-H') || process.env.HOST || '127.0.0.1';
const postmanDataDirArg = getArgValue('--postman-data-dir', '-d');
const workspaceIdArg = getArgValue('--workspace-id', '-w');
const POSTMAN_GATEWAY_URL = process.env.POSTMAN_GATEWAY_URL || 'https://gateway.postman.com';

function getDefaultPostmanDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Postman');
  }
  if (process.platform === 'win32') {
    if (!process.env.APPDATA) throw new Error('Windows 环境变量 APPDATA 未设置');
    return path.join(process.env.APPDATA, 'Postman');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Postman');
}

const POSTMAN_DATA_DIR = postmanDataDirArg || process.env.POSTMAN_DATA_DIR || getDefaultPostmanDataDir();

function getPostmanAuthInfo() {
  const partitionFile = path.join(POSTMAN_DATA_DIR, 'storage', 'userPartitionData.json');
  if (!fs.existsSync(partitionFile)) {
    throw new Error(`Postman 登录信息文件未找到: ${partitionFile}`);
  }
  const data = JSON.parse(fs.readFileSync(partitionFile, 'utf8'));
  const activePartition = data.v8PartitionsNamespaceMeta?.users?.activePartition;
  const user = activePartition && data.v8Partitions?.[activePartition];
  if (!user) throw new Error('未找到 Postman 活跃用户，请先登录 Postman');
  const auth = JSON.parse(user.meta?.raw || '{}').auth;
  if (!auth?.access_token) throw new Error('Postman 登录令牌不存在，请重新登录 Postman');
  return {
    accessToken: auth.access_token,
    teamId: user.context?.teamId,
    userId: user.context?.userId
  };
}

function readTail(file, maxBytes = 5 * 1024 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function discoverWorkspaceId() {
  const explicit = workspaceIdArg || process.env.POSTMAN_WORKSPACE_ID;
  if (explicit) return explicit;

  const logFile = path.join(POSTMAN_DATA_DIR, 'logs', 'renderer-requester.log');
  if (!fs.existsSync(logFile)) return null;
  const text = readTail(logFile);
  const patterns = [
    /[?&]workspace=([0-9a-f]{8}-[0-9a-f-]{27,})/gi,
    /["']workspaceId["']\s*[:=]\s*["']([0-9a-f]{8}-[0-9a-f-]{27,})/gi
  ];
  let latest = null;
  let latestIndex = -1;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match.index > latestIndex) {
        latest = match[1];
        latestIndex = match.index;
      }
    }
  }
  return latest;
}

function getPostmanVersion() {
  if (process.env.POSTMAN_APP_VERSION) return process.env.POSTMAN_APP_VERSION;
  const settingsFile = path.join(POSTMAN_DATA_DIR, 'storage', 'settings.json');
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8')).lastKnownVersion || '12.23.1';
  } catch {
    return '12.23.1';
  }
}

const APP_VERSION = getPostmanVersion();
const PLATFORM = process.platform === 'darwin'
  ? 'DESKTOP_MACOS'
  : process.platform === 'win32' ? 'DESKTOP_WINDOWS' : 'DESKTOP_LINUX';
const TARGET = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux';

function clientMetadata() {
  const knownBuild = APP_VERSION === '12.23.1' ? 'ui-260811-0231' : null;
  return {
    clientTools: {
      native: [],
      excludedTools: [],
      ...(knownBuild ? {
        nativeToolsHash: `clienttools-workspace_v12-desktop-${TARGET}-${APP_VERSION}-${knownBuild}-e00a5d3de76e`
      } : {})
    },
    clientKBTerms: {
      native: [],
      excludedKBTerms: [],
      ...(knownBuild ? {
        nativeTermsHash: `kbterms-workspace_v12-desktop-${TARGET}-${APP_VERSION}-${knownBuild}-7c8bd65f52ba`
      } : {})
    }
  };
}

function postmanHeaders(accessToken, accept = 'application/json') {
  return {
    'x-access-token': accessToken,
    'x-pstmn-req-service': 'agent-mode-service',
    'x-app-version': APP_VERSION,
    'Content-Type': 'application/json',
    Accept: accept
  };
}

let configCache = null;
async function getPostmanConfig(force = false) {
  if (!force && configCache && configCache.expiresAt > Date.now()) return configCache.value;
  const { accessToken } = getPostmanAuthInfo();
  const response = await fetch(`${POSTMAN_GATEWAY_URL}/config?platform=${PLATFORM}`, {
    headers: postmanHeaders(accessToken)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Postman 配置接口返回 HTTP ${response.status}: ${text.slice(0, 300)}`);
  const parsed = JSON.parse(text);
  const value = parsed.data || parsed;
  if (value.result && value.result !== 'success') throw new Error(`Postman 配置接口失败: ${value.result}`);
  configCache = { value, expiresAt: Date.now() + 5 * 60 * 1000 };
  return value;
}

function normalizeModel(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function resolveModel(requested, config) {
  if (!requested || ['postbot', 'default', 'auto'].includes(String(requested).toLowerCase())) return null;
  const normalized = normalizeModel(requested);
  const models = config.models || [];
  const exact = models.find((model) =>
    normalizeModel(model.key) === normalized || normalizeModel(model.displayName) === normalized
  );
  if (exact) return exact.key;

  const fuzzy = models.find((model) => {
    const display = normalizeModel(model.displayName);
    return display.includes(normalized) || normalized.includes(display);
  });
  if (fuzzy) return fuzzy.key;
  throw new Error(`Postman 账号不支持模型 ${requested}。可用模型: ${models.map((m) => m.key).join(', ')}`);
}

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text') return block.text || '';
    if (block?.type === 'tool_result') {
      return `[工具结果 ${block.tool_use_id || ''}]\n${contentToText(block.content)}`;
    }
    if (block?.type === 'tool_use') {
      return `[工具调用 ${block.name || ''}]\n${JSON.stringify(block.input || {})}`;
    }
    if (block?.type === 'image' || block?.type === 'image_url') return '[图片内容未转发]';
    return JSON.stringify(block);
  }).join('\n');
}

function buildPrompt(payload) {
  const sections = [];
  if (payload.system) sections.push(`系统提示:\n${contentToText(payload.system)}`);
  if (Array.isArray(payload.messages)) {
    for (const message of payload.messages) {
      const role = message.role === 'assistant' ? '助手' : message.role === 'system' ? '系统' : '用户';
      sections.push(`${role}:\n${contentToText(message.content)}`);
    }
  } else if (payload.prompt) {
    sections.push(String(payload.prompt));
  }
  return sections.join('\n\n') || '你好';
}

function buildPostmanBody(payload, config, workspaceId) {
  const selectedModel = resolveModel(payload.model, config);
  return {
    input: {
      chatType: 'USER_QUERY',
      query: buildPrompt(payload),
      toolResponse: '',
      useCase: null,
      conversationId: null,
      agent: null,
      product: 'workspace_v12'
    },
    platform: PLATFORM,
    ...clientMetadata(),
    mandatoryContext: { workspaceId },
    selectedContext: [],
    backgroundContext: [],
    availableSkills: [],
    devModeOptions: {
      selectedModel,
      isParallelToolCallingSupported: true,
      autoRun: false,
      supportsAskUser: false,
      supportsActionRecommendations: false,
      useThinkingModeIfAvailable: false,
      thinkingLevel: null,
      isLoopApprovalEnabled: false,
      enableWebAccess: false
    }
  };
}

async function parseSSE(stream, onEvent) {
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) await onEvent(data);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const data = buffer.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (data) await onEvent(data);
  }
}

async function callPostman(payload, handlers = {}, signal) {
  const workspaceId = discoverWorkspaceId();
  if (!workspaceId) {
    throw new Error('无法识别 Postman 工作区。请使用 --workspace-id <UUID> 或设置 POSTMAN_WORKSPACE_ID');
  }
  const config = await getPostmanConfig();
  const requestedModel = payload.model || 'postbot';
  const body = buildPostmanBody(payload, config, workspaceId);
  const { accessToken } = getPostmanAuthInfo();
  const response = await fetch(`${POSTMAN_GATEWAY_URL}/chat`, {
    method: 'POST',
    headers: postmanHeaders(accessToken, 'text/event-stream'),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Postman Chat 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.body) throw new Error('Postman Chat 没有返回响应流');
  handlers.onStart?.({ requestedModel });

  const result = {
    text: '',
    conversationId: null,
    model: body.devModeOptions.selectedModel || config.defaultModel || requestedModel,
    usage: null
  };
  await parseSSE(response.body, async (data) => {
    if (data === '[DONE]') return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.eventType === 'conversation') {
      result.conversationId = event.data?.id || result.conversationId;
      result.model = event.data?.modelKey || result.model;
      handlers.onConversation?.(event.data || {});
    } else if (event.eventType === 'textChunk') {
      const text = event.data?.textContent || event.data?.content || event.data?.text || '';
      if (text) {
        result.text += text;
        handlers.onText?.(text);
      }
    } else if (event.eventType === 'usage') {
      result.usage = event.data || null;
    } else if (event.eventType === 'failure') {
      throw new Error(event.data?.message || event.data?.userMessage || 'Postman Chat 返回失败事件');
    }
  });
  handlers.onEnd?.(result);
  return result;
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function apiError(res, status, message, anthropic = false) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (anthropic) {
    json(res, status, { type: 'error', error: { type: 'api_error', message } });
  } else {
    json(res, status, { error: { message, type: 'postman_gateway_error' } });
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10 * 1024 * 1024) throw new Error('请求体超过 10 MB');
  }
  return JSON.parse(body || '{}');
}

async function handleOpenAI(payload, res, abortController) {
  const stream = payload.stream === true;
  const id = `chatcmpl-postman-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!stream) {
    const result = await callPostman(payload, {}, abortController.signal);
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: result.model,
      choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: estimateTokens(buildPrompt(payload)),
        completion_tokens: estimateTokens(result.text),
        total_tokens: estimateTokens(buildPrompt(payload)) + estimateTokens(result.text)
      }
    });
  }

  let started = false;
  await callPostman(payload, {
    onStart: () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      started = true;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model || 'postbot', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    },
    onText: (text) => {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model || 'postbot', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    }
  }, abortController.signal);
  if (started && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model || 'postbot', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  }
}

async function handleAnthropic(payload, res, abortController) {
  const stream = payload.stream === true;
  const id = `msg_postman_${Date.now()}`;
  const model = payload.model || 'postbot';
  const inputTokens = estimateTokens(buildPrompt(payload));
  if (!stream) {
    const result = await callPostman(payload, {}, abortController.signal);
    return json(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content: [{ type: 'text', text: result.text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: estimateTokens(result.text) }
    });
  }

  let started = false;
  let output = '';
  await callPostman(payload, {
    onStart: () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      started = true;
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inputTokens, output_tokens: 0 } } })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`);
    },
    onText: (text) => {
      output += text;
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`);
    }
  }, abortController.signal);
  if (started && !res.writableEnded) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`);
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: estimateTokens(output) } })}\n\n`);
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  }
}

function printHelp() {
  console.log(`
Postman Postbot 真实转发网关（macOS / Windows / Linux）

用法:
  node postman-gateway-macos.js [选项]

选项:
  -h, --help                    显示帮助
  -p, --port <number>           监听端口，默认 9887
  -H, --host <address>          绑定地址，默认 127.0.0.1
  -d, --postman-data-dir <path> Postman 用户数据目录
  -w, --workspace-id <uuid>     Postman 工作区；默认从客户端日志自动识别

接口:
  GET  /                        健康状态
  GET  /v1/models               真实可用模型
  POST /v1/chat/completions     OpenAI Chat Completions 兼容接口
  POST /v1/messages             Anthropic Messages 兼容接口
  POST /v1/messages/count_tokens Anthropic Token Count 兼容接口

注意:
  该网关使用 Postman 桌面端的内部接口，可能随 Postman 更新而变化。
  默认仅监听本机，不会输出登录令牌。
`);
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error('无效端口:', PORT);
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  const route = req.url.split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, anthropic-beta, x-api-key');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    if (req.method === 'GET' && route === '/') {
      return json(res, 200, {
        status: 'ok',
        mode: 'real-postman-forwarding',
        platform: PLATFORM,
        postmanVersion: APP_VERSION,
        workspaceDetected: Boolean(discoverWorkspaceId())
      });
    }

    if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
      const config = await getPostmanConfig();
      return json(res, 200, {
        object: 'list',
        data: (config.models || []).map((model) => ({
          id: model.key,
          object: 'model',
          created: 0,
          owned_by: 'postman-postbot',
          display_name: model.displayName
        })),
        default_model: config.defaultModel,
        usage: config.usage
      });
    }

    if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
      const payload = await readJsonBody(req);
      return json(res, 200, { input_tokens: estimateTokens(buildPrompt(payload)) });
    }

    if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/v1/messages')) {
      const payload = await readJsonBody(req);
      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });
      console.log(`[Postman Gateway] ${route} -> ${payload.model || 'postbot'}: ${buildPrompt(payload).slice(0, 80).replace(/\s+/g, ' ')}`);
      if (route === '/v1/messages') {
        return await handleAnthropic(payload, res, abortController);
      }
      return await handleOpenAI(payload, res, abortController);
    }

    return json(res, 404, { error: { message: 'Endpoint not found', type: 'not_found' } });
  } catch (error) {
    console.error('[Postman Gateway Error]', error.message);
    const status = /不支持模型/.test(error.message) ? 400 : 502;
    apiError(res, status, error.message, route.startsWith('/v1/messages'));
  }
});

server.listen(PORT, HOST, async () => {
  let accountReady = false;
  let modelSummary = '读取失败';
  try {
    getPostmanAuthInfo();
    accountReady = true;
    const config = await getPostmanConfig();
    modelSummary = `${(config.models || []).length} 个模型，默认 ${config.defaultModel || 'auto'}`;
  } catch (error) {
    modelSummary = error.message;
  }
  console.log('=================================================================');
  console.log(' 🚀 Postman Postbot 真实转发网关已启动');
  console.log('-----------------------------------------------------------------');
  console.log(` 监听地址: http://${HOST}:${PORT}`);
  console.log(` 系统平台: ${process.platform} (${process.arch}) / ${PLATFORM}`);
  console.log(` Postman 版本: ${APP_VERSION}`);
  console.log(` 登录信息: ${accountReady ? '✅ 已读取（令牌不会输出）' : '❌ 未读取'}`);
  console.log(` 工作区: ${discoverWorkspaceId() ? '✅ 已自动识别' : '❌ 未识别，请传入 --workspace-id'}`);
  console.log(` 模型配置: ${modelSummary}`);
  console.log(' 转发模式: ✅ gateway.postman.com/chat 真实请求');
  console.log('=================================================================');
});
