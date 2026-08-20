#!/usr/bin/env node

'use strict';

const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);

function getArgValue(flag, shortFlag) {
  const index = argv.findIndex((arg) => arg === flag || arg === shortFlag);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : null;
}

const showHelp = argv.includes('--help') || argv.includes('-h') || argv.includes('help');
const PORT = Number.parseInt(getArgValue('--port', '-p') || process.env.PORT || '9887', 10);
const HOST = getArgValue('--host', '-H') || process.env.HOST || '127.0.0.1';
const postmanDataDirArg = getArgValue('--postman-data-dir', '-d');
const workspaceIdArg = getArgValue('--workspace-id', '-w');
const POSTMAN_GATEWAY_URL = process.env.POSTMAN_GATEWAY_URL || 'https://gateway.postman.com';
const MAX_QUERY_CHARS = Math.min(9900, Number.parseInt(process.env.POSTMAN_MAX_QUERY_CHARS || '9800', 10));
const SESSION_TTL_MS = Number.parseInt(process.env.POSTMAN_SESSION_TTL_MS || String(12 * 60 * 60 * 1000), 10);
const DEBUG = process.env.POSTMAN_GATEWAY_DEBUG === '1';

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
const STATE_FILE = process.env.POSTMAN_GATEWAY_STATE_FILE || path.join(os.homedir(), '.postman-postbot-gateway', 'sessions.json');

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

const MACOS_12_23_1_HASHES = {
  workspace_v12: {
    tools: 'clienttools-workspace_v12-desktop-darwin-12.23.1-ui-260811-0231-e00a5d3de76e',
    kb: 'kbterms-workspace_v12-desktop-darwin-12.23.1-ui-260811-0231-7c8bd65f52ba'
  },
  workspace_tools_sdk_localmode: {
    tools: 'clienttools-workspace_tools_sdk_localmode-desktop-darwin-12.23.1-ui-260811-0231-e23d250ee33a',
    kb: 'kbterms-workspace_tools_sdk_localmode-desktop-darwin-12.23.1-ui-260811-0231-dbc2c7575e92'
  }
};

function clientMetadata(product, postmanTools = []) {
  const known = process.platform === 'darwin' && APP_VERSION === '12.23.1'
    ? MACOS_12_23_1_HASHES[product]
    : null;
  const toolsHash = process.env.POSTMAN_CLIENT_TOOLS_HASH || known?.tools;
  const kbHash = process.env.POSTMAN_KB_TERMS_HASH || known?.kb;
  const clientTools = {
    native: [],
    excludedTools: [],
    ...(toolsHash ? { nativeToolsHash: toolsHash } : {})
  };
  if (postmanTools.length) {
    clientTools.thirdParty = { 'external-client': { tools: postmanTools } };
  }
  return {
    clientTools,
    clientKBTerms: {
      native: [],
      excludedKBTerms: [],
      ...(kbHash ? { nativeTermsHash: kbHash } : {})
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
  if (!response.ok) throw new GatewayError(`Postman 配置接口返回 HTTP ${response.status}: ${text.slice(0, 300)}`, 502);
  const parsed = JSON.parse(text);
  const value = parsed.data || parsed;
  if (value.result && value.result !== 'success') throw new GatewayError(`Postman 配置接口失败: ${value.result}`, 502);
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
  const family = ['sonnet', 'opus', 'haiku'].find((name) => normalized.includes(name));
  if (family) {
    const compatible = models.find((model) => {
      const candidate = normalizeModel(`${model.key} ${model.displayName}`);
      return candidate.includes(family);
    });
    if (compatible) return compatible.key;
  }
  throw new GatewayError(`Postman 账号不支持模型 ${requested}。可用模型: ${models.map((m) => m.key).join(', ')}`, 400);
}

class GatewayError extends Error {
  constructor(message, status = 502, code = 'postman_gateway_error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sha(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function getAnthropicStructuredOutput(payload) {
  const format = payload?.output_config?.format || payload?.output_format;
  if (!format || format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object') {
    return null;
  }
  return { schema: format.schema };
}

function structuredOutputInstruction(payload, protocol) {
  if (protocol !== 'anthropic') return '';
  const structured = getAnthropicStructuredOutput(payload);
  if (!structured) return '';
  const schema = JSON.stringify(structured.schema);
  if (schema.length > 7000) {
    throw new GatewayError('结构化输出 JSON Schema 超过 Postman 单次输入可安全转发的大小', 400, 'structured_output_schema_too_large');
  }
  return [
    '[STRUCTURED_OUTPUT_REQUIRED]',
    'Return ONLY the JSON value required by the following JSON Schema.',
    'Do not use Markdown fences, prose, labels, or a leading Yes/No sentence.',
    'The response is machine-validated. Every required property must be present and no undeclared property may be added.',
    `JSON Schema: ${schema}`,
    '[/STRUCTURED_OUTPUT_REQUIRED]'
  ].join('\n');
}

function isClaudeCodeAutoModeClassifier(payload, protocol) {
  if (protocol !== 'anthropic') return false;
  const system = systemText(payload, protocol);
  return /security monitor for autonomous AI coding agents/i.test(system)
    && /## Output Format/.test(system)
    && /<block>no<\/block>/.test(system);
}

function autoModeClassifierInstruction(payload, protocol) {
  if (!isClaudeCodeAutoModeClassifier(payload, protocol)) return '';
  return [
    '[CLAUDE_CODE_AUTO_MODE_RESPONSE_CONTRACT]',
    'This is a machine safety-classification request, not a request to execute or explain the final action.',
    'Apply the supplied security policy to the final action.',
    'If allowed, reply exactly: <block>no</block>',
    'If blocked, reply exactly: <block>yes</block><category>Exact Rule Name</category><reason>[Exact Rule Name] one short sentence</reason>',
    'Return XML only. Do not mention Postman, capabilities, or provide any prose.',
    '[/CLAUDE_CODE_AUTO_MODE_RESPONSE_CONTRACT]'
  ].join('\n');
}

function autoModeClassifierRepairPayload(payload, protocol) {
  if (!isClaudeCodeAutoModeClassifier(payload, protocol)) return payload;
  return {
    ...payload,
    stream: false,
    tools: [],
    messages: [{
      role: 'user',
      content: [
        '[CLAUDE_CODE_AUTO_MODE_XML_REPAIR]',
        'Your preceding answer could not be parsed by the safety-classification client.',
        'Re-evaluate the same final action using the security policy already present in this conversation.',
        'Do not execute the action and do not explain capabilities.',
        'If allowed, reply exactly: <block>no</block>',
        'If blocked, reply exactly: <block>yes</block><category>Exact Rule Name</category><reason>[Exact Rule Name] one short sentence</reason>',
        'Return XML only.',
        '[/CLAUDE_CODE_AUTO_MODE_XML_REPAIR]'
      ].join('\n')
    }]
  };
}

function jsonTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function validateJsonSchema(value, schema, location = '$') {
  if (schema === true) return [];
  if (schema === false) return [`${location} is rejected by the schema`];
  if (!schema || typeof schema !== 'object') return [];

  if (schema.const !== undefined && stableJson(value) !== stableJson(schema.const)) {
    return [`${location} does not match const`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => stableJson(item) === stableJson(value))) {
    return [`${location} is not in enum`];
  }
  if (Array.isArray(schema.allOf)) {
    const errors = schema.allOf.flatMap((item) => validateJsonSchema(value, item, location));
    if (errors.length) return errors;
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => validateJsonSchema(value, item, location).length === 0)) {
    return [`${location} does not match anyOf`];
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => validateJsonSchema(value, item, location).length === 0).length;
    if (matches !== 1) return [`${location} does not match exactly one oneOf branch`];
  }

  const allowedTypes = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (allowedTypes.length && !allowedTypes.some((type) => jsonTypeMatches(value, type))) {
    return [`${location} must be ${allowedTypes.join(' or ')}`];
  }

  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return [`${location} is shorter than minLength`];
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return [`${location} is longer than maxLength`];
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) return [`${location} does not match pattern`];
      } catch {
        return [`${location} has an unsupported schema pattern`];
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return [`${location} is below minimum`];
    if (typeof schema.maximum === 'number' && value > schema.maximum) return [`${location} is above maximum`];
  }

  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) return [`${location} has too few items`];
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) return [`${location} has too many items`];
    if (schema.items) {
      for (const [index, item] of value.entries()) {
        const errors = validateJsonSchema(item, schema.items, `${location}[${index}]`);
        if (errors.length) return errors;
      }
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) return [`${location}.${required} is required`];
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        const errors = validateJsonSchema(item, properties[key], `${location}.${key}`);
        if (errors.length) return errors;
      } else if (schema.additionalProperties === false) {
        return [`${location}.${key} is not allowed`];
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        const errors = validateJsonSchema(item, schema.additionalProperties, `${location}.${key}`);
        if (errors.length) return errors;
      }
    }
  }
  return [];
}

function parseJsonCandidate(text) {
  const trimmed = String(text || '').trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  for (let start = 0; start < trimmed.length; start += 1) {
    const opener = trimmed[start];
    if (opener !== '{' && opener !== '[') continue;
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < trimmed.length; index += 1) {
      const char = trimmed[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
        continue;
      }
      if (char === '"') quoted = true;
      else if (char === opener) depth += 1;
      else if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

function coerceGoalHookVerdict(text, schema) {
  const properties = schema?.properties || {};
  const required = new Set(schema?.required || []);
  const isGoalHookSchema = properties.ok?.type === 'boolean'
    && properties.reason?.type === 'string'
    && required.has('ok')
    && required.has('reason');
  if (!isGoalHookSchema) return null;

  const trimmed = String(text || '').trim();
  const negative = trimmed.match(/^(?:no|false)\b[\s:.,;!\-–—]*/i)
    || trimmed.match(/^(?:not\s+(?:met|satisfied|complete(?:d)?))\b[\s:.,;!\-–—]*/i)
    || trimmed.match(/^(?:否|未完成|没有完成|不满足)[\s：:，,。.]*/);
  const positive = trimmed.match(/^(?:yes|true)\b[\s:.,;!\-–—]*/i)
    || trimmed.match(/^(?:(?:condition\s+)?(?:met|satisfied|complete(?:d)?))\b[\s:.,;!\-–—]*/i)
    || trimmed.match(/^(?:是|已完成|满足)[\s：:，,。.]*/);
  if (!negative && !positive) return null;
  const prefix = negative || positive;
  const reason = trimmed.slice(prefix[0].length).trim()
    || (negative ? 'The condition is not met.' : 'The condition is met.');
  return { ok: Boolean(positive), reason };
}

function normalizeAnthropicStructuredResult(payload, result) {
  const structured = getAnthropicStructuredOutput(payload);
  if (!structured || (result.toolCalls && result.toolCalls.length)) return result;

  let value = parseJsonCandidate(result.text);
  let errors = value === null ? ['response is not JSON'] : validateJsonSchema(value, structured.schema);
  if (errors.length) {
    const coerced = coerceGoalHookVerdict(result.text, structured.schema);
    if (coerced) {
      value = coerced;
      errors = validateJsonSchema(value, structured.schema);
    }
  }
  if (errors.length) {
    throw new GatewayError(
      `Postman 模型未返回符合 JSON Schema 的结构化输出: ${errors[0]}`,
      502,
      'invalid_structured_output'
    );
  }
  return { ...result, text: JSON.stringify(value) };
}

function normalizeAnthropicAutoModeResult(payload, protocol, result) {
  if (!isClaudeCodeAutoModeClassifier(payload, protocol) || (result.toolCalls && result.toolCalls.length)) {
    return result;
  }
  const text = String(result.text || '');
  const decision = text.match(/<block>\s*(yes|no)\s*<\/block>/i);
  if (!decision) {
    throw new GatewayError(
      'Postman 模型未返回 Claude Code Auto mode 要求的 XML 判定',
      502,
      'invalid_auto_mode_classifier_output'
    );
  }
  if (decision[1].toLowerCase() === 'no') return { ...result, text: '<block>no</block>' };

  const category = text.match(/<category>\s*([\s\S]*?)\s*<\/category>/i)?.[1]?.trim();
  const reason = text.match(/<reason>\s*([\s\S]*?)\s*<\/reason>/i)?.[1]?.trim();
  if (!category || !reason) {
    throw new GatewayError(
      'Postman 模型返回了阻止判定，但缺少 Auto mode 所需的 category 或 reason',
      502,
      'invalid_auto_mode_classifier_output'
    );
  }
  return {
    ...result,
    text: `<block>yes</block><category>${category}</category><reason>${reason}</reason>`
  };
}

function contentToText(content, options = {}) {
  const includeToolBlocks = options.includeToolBlocks !== false;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : safeJson(content);
  return content.map((block) => {
    if (typeof block === 'string') return block;
    if (block?.type === 'text' || block?.type === 'input_text' || block?.type === 'output_text') {
      return block.text || '';
    }
    if (block?.type === 'tool_result') {
      return includeToolBlocks ? `[工具结果 ${block.tool_use_id || ''}]\n${contentToText(block.content)}` : '';
    }
    if (block?.type === 'tool_use' || block?.type === 'function_call') {
      return includeToolBlocks
        ? `[工具调用 ${block.name || ''}]\n${safeJson(block.input || block.arguments || {})}`
        : '';
    }
    if (block?.type === 'image' || block?.type === 'image_url' || block?.type === 'input_image') return '[图片内容未转发]';
    if (block?.type === 'file' || block?.type === 'input_file') return '[文件内容未转发]';
    return includeToolBlocks ? safeJson(block) : '';
  }).filter(Boolean).join('\n');
}

function protocolMessages(payload, protocol) {
  if (protocol === 'responses') {
    if (typeof payload.input === 'string') return [{ role: 'user', content: payload.input }];
    if (!Array.isArray(payload.input)) return [];
    return payload.input.filter((item) => item && (item.role || item.type === 'message')).map((item) => ({
      role: item.role || 'user',
      content: item.content
    }));
  }
  return Array.isArray(payload.messages) ? payload.messages : [];
}

function systemText(payload, protocol) {
  const sections = [];
  if (payload.system) sections.push(contentToText(payload.system));
  if (payload.instructions) sections.push(contentToText(payload.instructions));
  for (const message of protocolMessages(payload, protocol)) {
    if (message.role === 'system' || message.role === 'developer') sections.push(contentToText(message.content));
  }
  return sections.filter(Boolean).join('\n\n');
}

function latestUserText(payload, protocol) {
  const messages = protocolMessages(payload, protocol);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      const text = contentToText(messages[i].content, { includeToolBlocks: false }).trim();
      if (text) return text;
    }
  }
  if (typeof payload.prompt === 'string') return payload.prompt;
  if (protocol === 'responses' && typeof payload.input === 'string') return payload.input;
  return '';
}

function firstUserText(payload, protocol) {
  const first = protocolMessages(payload, protocol).find((message) => message.role === 'user');
  return first ? contentToText(first.content, { includeToolBlocks: false }).slice(0, 2000) : '';
}

function contextAnchor(payload, protocol) {
  return sha(`${systemText(payload, protocol).slice(0, 3000)}\n${firstUserText(payload, protocol)}`);
}

function truncateSystemText(system, budget) {
  if (system.length <= budget) return system;
  const marker = '\n[系统提示中段已由网关截断；保留开头与末尾输出协议]\n';
  const available = Math.max(0, budget - marker.length);
  const tailBudget = Math.min(3000, Math.max(1200, Math.floor(available * 0.55)));
  const headBudget = available - tailBudget;
  return `${system.slice(0, headBudget)}${marker}${system.slice(-tailBudget)}`;
}

function fitQuery(system, user, isNewConversation) {
  let query = user.trim() || '请继续。';
  if (isNewConversation && system.trim()) {
    const systemBudget = Math.min(5600, Math.max(1800, MAX_QUERY_CHARS - Math.min(query.length, 4000) - 80));
    const systemPart = truncateSystemText(system, systemBudget);
    query = `[客户端系统提示]\n${systemPart}\n\n[用户请求]\n${query}`;
  }
  if (query.length > MAX_QUERY_CHARS) {
    const marker = '\n[前文因 Postman 单次输入限制已截断]\n';
    query = marker + query.slice(-(MAX_QUERY_CHARS - marker.length));
  }
  return query;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeToolArguments(value) {
  const raw = typeof value === 'string' ? value : safeJson(value ?? {});
  try {
    return stableJson(JSON.parse(raw));
  } catch {
    return raw.trim();
  }
}

function latestAssistantToolCalls(payload, protocol) {
  if (protocol === 'responses' && Array.isArray(payload.input)) {
    const calls = [];
    for (let index = payload.input.length - 1; index >= 0; index -= 1) {
      const item = payload.input[index];
      if (item?.type === 'function_call_output') continue;
      if (item?.type === 'function_call') {
        calls.unshift({ id: item.call_id || item.id, name: item.name, arguments: item.arguments || '' });
        continue;
      }
      if (calls.length) break;
    }
    return calls;
  }

  const messages = protocolMessages(payload, protocol);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return message.tool_calls.map((tool) => ({
        id: tool.id,
        name: tool.function?.name,
        arguments: tool.function?.arguments || ''
      }));
    }
    if (Array.isArray(message.content)) {
      const calls = message.content.filter((block) => block?.type === 'tool_use').map((tool) => ({
        id: tool.id,
        name: tool.name,
        arguments: safeJson(tool.input || {})
      }));
      if (calls.length) return calls;
    }
    return [];
  }
  return [];
}

function canonicalToolCallsWithoutIds(calls) {
  return calls.map((tool) => `tool:${tool.name || ''}:${normalizeToolArguments(tool.arguments)}`).join('|');
}

function canonicalAssistantFromPayload(payload, protocol) {
  if (protocol === 'responses' && Array.isArray(payload.input)) {
    for (let i = payload.input.length - 1; i >= 0; i -= 1) {
      const item = payload.input[i];
      if (item?.type === 'function_call') return `tool:${item.call_id || item.id}:${item.name}:${item.arguments || ''}`;
      if (item?.role === 'assistant') return `text:${contentToText(item.content)}`;
    }
    return '';
  }
  const messages = protocolMessages(payload, protocol);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      return message.tool_calls.map((tool) => `tool:${tool.id}:${tool.function?.name}:${tool.function?.arguments || ''}`).join('|');
    }
    if (Array.isArray(message.content)) {
      const uses = message.content.filter((block) => block?.type === 'tool_use');
      if (uses.length) return uses.map((tool) => `tool:${tool.id}:${tool.name}:${safeJson(tool.input || {})}`).join('|');
    }
    return `text:${contentToText(message.content)}`;
  }
  return '';
}

function hasConversationLineage(payload, protocol) {
  if (extractToolResults(payload, protocol).length) return true;
  if (canonicalAssistantFromPayload(payload, protocol)) return true;
  if (payload.previous_response_id || payload.conversation) return true;
  return protocolMessages(payload, protocol).some((message) => message.role === 'tool');
}

function externalSessionKeys(payload, req) {
  const values = [
    req.headers['x-postman-session-id'],
    req.headers['x-session-id'],
    req.headers['x-conversation-id'],
    payload.metadata?.user_id,
    payload.metadata?.session_id,
    payload.user,
    typeof payload.conversation === 'string' ? payload.conversation : payload.conversation?.id
  ].filter((value) => typeof value === 'string' && value.length > 0);
  return values.map((value) => `external:${sha(value)}`);
}

function debugRequestShape(payload, protocol, req) {
  if (!DEBUG) return;
  const messages = protocolMessages(payload, protocol);
  const assistantCalls = [];
  for (const message of messages) {
    if (message?.role !== 'assistant') continue;
    for (const tool of message.tool_calls || []) {
      assistantCalls.push({ id: tool?.id || null, name: tool?.function?.name || null });
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === 'tool_use') assistantCalls.push({ id: block.id || null, name: block.name || null });
      }
    }
  }
  console.log('[Postman Gateway Debug] request-shape', JSON.stringify({
    protocol,
    roles: messages.map((message) => message?.role || null),
    assistantCalls,
    toolResults: extractToolResults(payload, protocol).map((result) => result.callId),
    previousResponseId: payload.previous_response_id || null,
    externalKeyCount: externalSessionKeys(payload, req).length,
    anchor: contextAnchor(payload, protocol).slice(0, 12)
  }));
}

function extractToolResults(payload, protocol) {
  const results = [];
  if (protocol === 'anthropic') {
    // Anthropic clients replay the complete conversation on every request.
    // Only tool_result blocks in the final user turn are new results; older
    // blocks are history and have already been sent to Postman.
    const message = Array.isArray(payload.messages) ? payload.messages.at(-1) : null;
    if (message?.role !== 'user' || !Array.isArray(message.content)) return results;
    for (const block of message.content) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        results.push({
          callId: block.tool_use_id,
          content: contentToText(block.content),
          isError: block.is_error === true
        });
      }
    }
  } else if (protocol === 'openai') {
    // Chat Completions represents parallel results as one or more consecutive
    // role=tool messages at the end of the current turn.
    const trailing = [];
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role !== 'tool') break;
      trailing.unshift(messages[index]);
    }
    for (const message of trailing) {
      if (message.tool_call_id) {
        results.push({
          callId: message.tool_call_id,
          content: contentToText(message.content),
          isError: message.is_error === true
        });
      }
    }
  } else if (protocol === 'responses' && Array.isArray(payload.input)) {
    // Responses clients may resend all previous input/output items. Only the
    // trailing function_call_output items belong to the current continuation.
    const trailing = [];
    for (let index = payload.input.length - 1; index >= 0; index -= 1) {
      if (payload.input[index]?.type !== 'function_call_output') break;
      trailing.unshift(payload.input[index]);
    }
    for (const item of trailing) {
      if (item.call_id) {
        results.push({
          callId: item.call_id,
          content: contentToText(item.output),
          isError: item.status === 'failed' || item.is_error === true
        });
      }
    }
  }
  return results;
}

function normalizeToolDefinitions(payload, protocol) {
  const source = Array.isArray(payload.tools) ? payload.tools : [];
  const seen = new Set();
  const definitions = [];
  for (const item of source) {
    let name;
    let description;
    let parameters;
    if (protocol === 'anthropic') {
      name = item?.name;
      description = item?.description;
      parameters = item?.input_schema;
    } else if (item?.type === 'function' && item.function) {
      name = item.function.name;
      description = item.function.description;
      parameters = item.function.parameters;
    } else if (item?.type === 'function') {
      name = item.name;
      description = item.description;
      parameters = item.parameters;
    } else if (item?.type === 'custom' && item.name) {
      name = item.name;
      description = item.description;
      parameters = {
        type: 'object',
        properties: { input: { type: 'string', description: 'Free-form tool input' } },
        required: ['input']
      };
    }
    if (!name || seen.has(name)) continue;
    seen.add(name);
    definitions.push({
      originalName: name,
      description: description || `Client-provided tool: ${name}`,
      parameters: parameters && typeof parameters === 'object'
        ? parameters
        : { type: 'object', properties: {} }
    });
  }
  return definitions;
}

function encodeToolName(name, used) {
  const base = `client__${String(name).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let encoded = base;
  if (encoded.length > 64) encoded = `${encoded.slice(0, 55)}_${sha(name).slice(0, 8)}`;
  if (used.has(encoded) && used.get(encoded) !== name) {
    encoded = `${encoded.slice(0, 55)}_${sha(name).slice(0, 8)}`;
  }
  used.set(encoded, name);
  return encoded;
}

function buildToolSet(payload, protocol) {
  const used = new Map();
  const originalToEncoded = new Map();
  const encodedToOriginal = new Map();
  const postmanTools = normalizeToolDefinitions(payload, protocol).map((tool) => {
    const encoded = encodeToolName(tool.originalName, used);
    originalToEncoded.set(tool.originalName, encoded);
    encodedToOriginal.set(encoded, tool.originalName);
    return {
      name: encoded,
      description: tool.description,
      parameters: tool.parameters
    };
  });
  return { postmanTools, originalToEncoded, encodedToOriginal };
}

class SessionStore {
  constructor(file) {
    this.file = file;
    this.states = new Map();
    this.aliases = new Map();
    this.toolCalls = new Map();
    this.responses = new Map();
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const saved of parsed.states || []) {
        if (!saved.id || Date.now() - saved.updatedAt > SESSION_TTL_MS) continue;
        const state = {
          id: saved.id,
          conversationId: saved.conversationId || null,
          product: saved.product || 'workspace_v12',
          anchor: saved.anchor || '',
          updatedAt: saved.updatedAt || Date.now(),
          pendingTools: new Map((saved.pendingTools || []).map((tool) => [tool.id, tool])),
          postmanTools: [],
          encodedToOriginal: new Map(),
          originalToEncoded: new Map()
        };
        this.states.set(state.id, state);
        for (const tool of state.pendingTools.values()) this.toolCalls.set(tool.id, state.id);
      }
      for (const [alias, id] of parsed.aliases || []) if (this.states.has(id)) this.aliases.set(alias, id);
      for (const [responseId, id] of parsed.responses || []) if (this.states.has(id)) this.responses.set(responseId, id);
    } catch (error) {
      if (error.code !== 'ENOENT' && DEBUG) console.warn('[Postman Gateway] 无法读取会话缓存:', error.message);
    }
  }

  persist() {
    try {
      this.cleanup(false);
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const data = {
        version: 1,
        states: [...this.states.values()].map((state) => ({
          id: state.id,
          conversationId: state.conversationId,
          product: state.product,
          anchor: state.anchor,
          updatedAt: state.updatedAt,
          pendingTools: [...state.pendingTools.values()]
        })),
        aliases: [...this.aliases.entries()],
        responses: [...this.responses.entries()]
      };
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      if (DEBUG) console.warn('[Postman Gateway] 无法保存会话缓存:', error.message);
    }
  }

  cleanup(persist = true) {
    const expired = [];
    for (const [id, state] of this.states) {
      if (Date.now() - state.updatedAt > SESSION_TTL_MS) expired.push(id);
    }
    for (const id of expired) this.states.delete(id);
    for (const [alias, id] of this.aliases) if (!this.states.has(id)) this.aliases.delete(alias);
    for (const [callId, id] of this.toolCalls) if (!this.states.has(id)) this.toolCalls.delete(callId);
    for (const [responseId, id] of this.responses) if (!this.states.has(id)) this.responses.delete(responseId);
    if (expired.length && persist) this.persist();
  }

  create(anchor) {
    const state = {
      id: crypto.randomUUID(),
      conversationId: null,
      product: 'workspace_v12',
      anchor,
      updatedAt: Date.now(),
      pendingTools: new Map(),
      postmanTools: [],
      encodedToOriginal: new Map(),
      originalToEncoded: new Map()
    };
    this.states.set(state.id, state);
    return state;
  }

  remapToolResults(state, toolResults, payload, protocol) {
    if (!toolResults.length) return toolResults;
    const clientCalls = latestAssistantToolCalls(payload, protocol);
    const claimed = new Set();
    const remapped = [];
    for (const result of toolResults) {
      if (state.pendingTools.has(result.callId)) {
        claimed.add(result.callId);
        remapped.push(result);
        continue;
      }
      const clientCall = clientCalls.find((call) => call.id === result.callId);
      if (!clientCall) return null;
      const normalizedArguments = normalizeToolArguments(clientCall.arguments);
      const candidates = [...state.pendingTools.values()].filter((pending) =>
        !claimed.has(pending.id)
        && pending.name === clientCall.name
        && pending.arguments != null
        && normalizeToolArguments(pending.arguments) === normalizedArguments
      );
      if (!candidates.length) return null;
      const pending = candidates[0];
      claimed.add(pending.id);
      remapped.push({ ...result, clientCallId: result.callId, callId: pending.id });
    }
    return remapped;
  }

  resolved(state, toolResults, payload, protocol) {
    const remapped = this.remapToolResults(state, toolResults, payload, protocol);
    if (remapped === null) return null;
    return { state, reused: true, toolResults: remapped };
  }

  resolve(payload, protocol, req) {
    this.cleanup();
    debugRequestShape(payload, protocol, req);
    const toolResults = extractToolResults(payload, protocol);
    for (const result of toolResults) {
      const state = this.states.get(this.toolCalls.get(result.callId));
      if (state) {
        const resolved = this.resolved(state, toolResults, payload, protocol);
        if (resolved) return resolved;
      }
    }
    if (payload.previous_response_id) {
      const state = this.states.get(this.responses.get(payload.previous_response_id));
      if (state) {
        const resolved = this.resolved(state, toolResults, payload, protocol);
        if (resolved) return resolved;
      }
    }
    const anchor = contextAnchor(payload, protocol);
    const previous = canonicalAssistantFromPayload(payload, protocol);
    if (previous) {
      const lineageAlias = `lineage:${sha(`${anchor}:${previous}`)}`;
      const state = this.states.get(this.aliases.get(lineageAlias));
      if (state) {
        const resolved = this.resolved(state, toolResults, payload, protocol);
        if (resolved) return resolved;
      }
    }
    if (toolResults.length) {
      const clientCalls = latestAssistantToolCalls(payload, protocol);
      if (clientCalls.length) {
        const lineageAlias = `tool-lineage:${sha(`${anchor}:${canonicalToolCallsWithoutIds(clientCalls)}`)}`;
        const state = this.states.get(this.aliases.get(lineageAlias));
        if (state) {
          const resolved = this.resolved(state, toolResults, payload, protocol);
          if (resolved) return resolved;
        }
      }
    }
    if (hasConversationLineage(payload, protocol)) {
      for (const key of externalSessionKeys(payload, req)) {
        const state = this.states.get(this.aliases.get(key));
        if (state) {
          const resolved = this.resolved(state, toolResults, payload, protocol);
          if (resolved) return resolved;
        }
      }
    }
    const state = this.create(anchor);
    for (const key of externalSessionKeys(payload, req)) this.aliases.set(key, state.id);
    this.persist();
    return { state, reused: false, toolResults };
  }

  configureTools(state, toolSet) {
    state.postmanTools = toolSet.postmanTools;
    state.encodedToOriginal = toolSet.encodedToOriginal;
    state.originalToEncoded = toolSet.originalToEncoded;
    if (toolSet.postmanTools.length) state.product = 'workspace_tools_sdk_localmode';
    state.updatedAt = Date.now();
  }

  updateConversation(state, conversationId) {
    if (conversationId) state.conversationId = conversationId;
    state.updatedAt = Date.now();
  }

  registerResult(state, payload, protocol, result, responseId) {
    state.updatedAt = Date.now();
    for (const tool of result.toolCalls) {
      state.pendingTools.set(tool.id, {
        id: tool.id,
        groupId: tool.groupId || null,
        name: tool.name,
        encodedName: tool.encodedName,
        arguments: tool.arguments || '{}'
      });
      this.toolCalls.set(tool.id, state.id);
    }
    if (responseId) this.responses.set(responseId, state.id);
    const canonical = result.toolCalls.length
      ? result.toolCalls.map((tool) => `tool:${tool.id}:${tool.name}:${tool.arguments}`).join('|')
      : `text:${result.text}`;
    this.aliases.set(`lineage:${sha(`${contextAnchor(payload, protocol)}:${canonical}`)}`, state.id);
    if (result.toolCalls.length) {
      const toolLineage = canonicalToolCallsWithoutIds(result.toolCalls);
      this.aliases.set(`tool-lineage:${sha(`${contextAnchor(payload, protocol)}:${toolLineage}`)}`, state.id);
    }
    this.persist();
  }

  completeToolResults(state, toolResults) {
    for (const item of toolResults) {
      state.pendingTools.delete(item.callId);
      this.toolCalls.delete(item.callId);
    }
    state.updatedAt = Date.now();
    this.persist();
  }
}

const sessionStore = new SessionStore(STATE_FILE);

function toolStatus(result) {
  const text = String(result.content || '').toLowerCase();
  if (/\b(rejected|denied|cancelled|canceled|not approved)\b|拒绝|未批准|取消执行/.test(text)) return 'REJECTED';
  if (result.isError) return 'FAILED';
  return 'SUCCESS';
}

function buildPostmanBody({ payload, protocol, config, workspaceId, state, toolResults }) {
  const selectedModel = resolveModel(payload.model, config);
  const common = {
    platform: PLATFORM,
    ...clientMetadata(state.product, state.postmanTools),
    mandatoryContext: { workspaceId },
    selectedContext: [],
    backgroundContext: [],
    availableSkills: [],
    devModeOptions: {
      selectedModel,
      isParallelToolCallingSupported: payload.parallel_tool_calls !== false,
      autoRun: false,
      supportsAskUser: false,
      supportsActionRecommendations: false,
      useThinkingModeIfAvailable: false,
      thinkingLevel: null,
      isLoopApprovalEnabled: false,
      enableWebAccess: false
    }
  };

  if (toolResults.length) {
    if (!state.conversationId) {
      throw new GatewayError('收到工具执行结果，但找不到对应的 Postman conversationId；请重新开始客户端会话', 400, 'unknown_tool_call');
    }
    const known = toolResults.map((result) => ({ result, pending: state.pendingTools.get(result.callId) }));
    const missing = known.filter((item) => !item.pending).map((item) => item.result.callId);
    if (missing.length) {
      throw new GatewayError(`找不到工具调用: ${missing.join(', ')}；网关可能已重启或会话已过期`, 400, 'unknown_tool_call');
    }
    const groups = new Set(known.map((item) => item.pending.groupId).filter(Boolean));
    if (groups.size > 1) {
      throw new GatewayError('一次请求包含来自不同 Postman 工具组的结果，客户端应按工具调用组分别回传', 400, 'mixed_tool_groups');
    }
    const groupId = [...groups][0];
    const input = {
      chatType: 'TOOL_RESPONSE',
      query: '',
      toolResponse: '',
      useCase: null,
      conversationId: state.conversationId,
      agent: null,
      product: state.product
    };
    if (groupId) {
      input.toolCallGroupId = groupId;
      input.toolResponses = known.map(({ result }) => ({
        toolCallId: result.callId,
        content: result.content || '(工具执行成功，无输出)',
        toolResponseSummary: toolStatus(result) === 'SUCCESS' ? 'Client tool completed' : 'Client tool did not complete successfully',
        toolResponseStatus: toolStatus(result),
        ...(toolStatus(result) === 'REJECTED' ? { toolResponseRejectionType: 'EXPLICIT' } : {})
      }));
    } else {
      const result = toolResults[0];
      input.toolCallId = result.callId;
      input.toolResponse = result.content || '(工具执行成功，无输出)';
      input.toolResponseSummary = toolStatus(result) === 'SUCCESS' ? 'Client tool completed' : 'Client tool failed';
    }
    return { ...common, input };
  }

  const structuredInstruction = structuredOutputInstruction(payload, protocol);
  const classifierInstruction = autoModeClassifierInstruction(payload, protocol);
  const userText = [latestUserText(payload, protocol), structuredInstruction, classifierInstruction]
    .filter(Boolean)
    .join('\n\n');
  const query = fitQuery(systemText(payload, protocol), userText, !state.conversationId);
  return {
    ...common,
    input: {
      chatType: 'USER_QUERY',
      query,
      toolResponse: '',
      useCase: null,
      conversationId: state.conversationId,
      agent: null,
      product: state.product
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

function postmanFailureError(failure) {
  if (failure?.consent === false) {
    const pathway = failure.consentPathway ? `（${failure.consentPathway}）` : '';
    return new GatewayError(
      `Postman 返回了 consent=false${pathway}。建议前往后台检查 AI 开启状态：https://postman.co/settings/team/ai`,
      403,
      'postman_agent_consent_required'
    );
  }
  const details = failure?.error || failure?.cause || failure?.details || {};
  const message = failure?.message
    || failure?.userMessage
    || failure?.errorMessage
    || details.message
    || details.userMessage
    || (typeof failure === 'string' ? failure : '')
    || 'Postman Chat 返回失败事件';
  const errorType = failure?.errorType || failure?.type || failure?.code || details.errorType || details.type || details.code || 'postman_failure';
  const status = /input|validation|too large/i.test(`${errorType} ${message}`) ? 400 : 502;
  return new GatewayError(message, status, errorType);
}

function mergePostmanToolCall(result, raw, eventType, index) {
  if (!raw) return;
  const id = raw.id || raw.toolCallId;
  if (!id) return;
  let tool = result.toolCallMap.get(id);
  if (!tool) {
    tool = {
      id,
      groupId: raw.toolCallGroupId || raw.groupId || null,
      encodedName: raw.function?.name || raw.name || '',
      name: '',
      arguments: '',
      index
    };
    result.toolCallMap.set(id, tool);
  }
  tool.groupId = raw.toolCallGroupId || raw.groupId || tool.groupId;
  tool.encodedName = raw.function?.name || raw.name || tool.encodedName;
  const argumentChunk = raw.function?.arguments ?? raw.arguments ?? '';
  if (eventType === 'toolCall') tool.arguments = typeof argumentChunk === 'string' ? argumentChunk : safeJson(argumentChunk);
  else tool.arguments += typeof argumentChunk === 'string' ? argumentChunk : safeJson(argumentChunk);
}

function parsedToolArguments(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstGlobIndex(value) {
  const indexes = ['*', '?', '[', '{']
    .map((character) => value.indexOf(character))
    .filter((index) => index !== -1);
  return indexes.length ? Math.min(...indexes) : -1;
}

function patternBaseDirectory(pattern) {
  const globIndex = firstGlobIndex(pattern);
  if (globIndex === -1) return path.dirname(pattern);
  const prefix = pattern.slice(0, globIndex);
  if (!prefix) return '.';
  if (/[\\/]$/.test(prefix)) return prefix.replace(/[\\/]+$/, '') || path.parse(pattern).root;
  return path.dirname(prefix);
}

function commonDirectory(directories) {
  let common = path.resolve(directories[0]);
  for (const directory of directories.slice(1)) {
    const resolved = path.resolve(directory);
    while (resolved !== common && !resolved.startsWith(`${common}${path.sep}`)) {
      const parent = path.dirname(common);
      if (parent === common) break;
      common = parent;
    }
  }
  return common;
}

function slashPath(value) {
  return String(value).split(path.sep).join('/');
}

function searchFilePatterns(input) {
  const candidates = Array.isArray(input.fileNamePatterns)
    ? input.fileNamePatterns
    : typeof input.fileNamePattern === 'string'
      ? [input.fileNamePattern]
      : [];
  return [...new Set(candidates.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim()))];
}

function searchScope(input) {
  const patterns = searchFilePatterns(input);
  const explicitPath = input.directoryPath || input.rootPath || input.path;
  if (typeof explicitPath === 'string' && explicitPath) {
    const globs = patterns.map((pattern) => path.isAbsolute(pattern)
      ? slashPath(path.relative(explicitPath, pattern))
      : slashPath(pattern));
    return { path: explicitPath, globs };
  }
  if (patterns.length && patterns.every((pattern) => path.isAbsolute(pattern))) {
    const root = commonDirectory(patterns.map(patternBaseDirectory));
    return {
      path: root,
      globs: patterns.map((pattern) => slashPath(path.relative(root, pattern)))
    };
  }
  return { path: undefined, globs: patterns.map(slashPath) };
}

function combinedGlob(globs) {
  if (!globs.length) return undefined;
  return globs.length === 1 ? globs[0] : `{${globs.join(',')}}`;
}

function searchResultLimit(input) {
  const parsed = Number.parseInt(input.maxResults ?? input.limit ?? '200', 10);
  return Math.min(1000, Math.max(1, Number.isFinite(parsed) ? parsed : 200));
}

function searchInFilesBashInput(input, scope, limit) {
  const command = ['rg', '--line-number', '--no-heading', '--color', 'never'];
  if (input.isRegex !== true) command.push('--fixed-strings');
  if (input.caseSensitive === false || input.isCaseSensitive === false) command.push('--ignore-case');
  for (const glob of scope.globs) command.push('--glob', shellQuote(glob));
  command.push('--', shellQuote(input.query), shellQuote(scope.path || '.'));
  return {
    command: `${command.join(' ')} | sed -n ${shellQuote(`1,${limit}p`)}`,
    description: '搜索文件内容'
  };
}

function normalizePostmanToolCall(state, tool) {
  let encodedName = tool.encodedName;
  let argumentsText = tool.arguments || '{}';
  let input = parsedToolArguments(argumentsText);

  // Postman sometimes wraps a third-party call in its own namespace router.
  // The external client only knows the original tool, so unwrap it before the
  // call is returned to Claude Code, Codex, or Trae.
  if (encodedName === 'executeNamespaceTool' && input?.namespace === 'external-client' && input.toolName) {
    encodedName = input.toolName;
    argumentsText = typeof input.input === 'string' ? input.input : safeJson(input.input || {});
    input = parsedToolArguments(argumentsText);
  }

  let name = state.encodedToOriginal.get(encodedName)
    || encodedName.replace(/^client__/, '')
    || encodedName;

  const available = (candidate) => state.originalToEncoded.has(candidate);
  if (encodedName === 'executeBashCommand' && available('Bash') && input?.command) {
    name = 'Bash';
    input = compactObject({
      command: input.command,
      description: input.description || '执行命令',
      timeout: input.timeout,
      run_in_background: input.isBackground === true || input.run_in_background === true
    });
    argumentsText = safeJson(input);
  } else if (encodedName === 'readFile' && available('Read') && input) {
    name = 'Read';
    input = compactObject({
      file_path: input.file_path || input.filePath || input.path,
      offset: input.offset,
      limit: input.limit,
      pages: input.pages
    });
    argumentsText = safeJson(input);
  } else if (encodedName === 'createFile' && available('Write') && input) {
    name = 'Write';
    input = compactObject({
      file_path: input.file_path || input.filePath || input.path,
      content: input.content ?? input.contents
    });
    argumentsText = safeJson(input);
  } else if (encodedName === 'searchInFiles' && typeof input?.query === 'string' && input.query) {
    const scope = searchScope(input);
    const limit = searchResultLimit(input);
    if (available('Grep')) {
      name = 'Grep';
      argumentsText = safeJson(compactObject({
        pattern: input.isRegex === true ? input.query : escapeRegex(input.query),
        path: scope.path,
        glob: combinedGlob(scope.globs),
        output_mode: 'content',
        '-n': true,
        '-i': input.caseSensitive === false || input.isCaseSensitive === false ? true : undefined,
        head_limit: limit
      }));
    } else if (available('Bash')) {
      name = 'Bash';
      argumentsText = safeJson(searchInFilesBashInput(input, scope, limit));
    }
  } else if (encodedName === 'listDirectory' && available('Bash') && input?.directoryPath) {
    name = 'Bash';
    const depth = Math.min(20, Math.max(1, Number.parseInt(input.depth || '1', 10) || 1));
    const exclusions = Array.isArray(input.ignoreGlobs)
      ? input.ignoreGlobs.filter((item) => typeof item === 'string' && item).map((item) =>
        `! -path ${shellQuote(`${input.directoryPath}/${item}`)}`)
      : [];
    argumentsText = safeJson({
      command: `find ${shellQuote(input.directoryPath)} -mindepth 1 -maxdepth ${depth} ${exclusions.join(' ')} -print | sort`,
      description: '读取目录内容'
    });
  } else if (encodedName === 'listNamespaces' && available('Bash')) {
    name = 'Bash';
    argumentsText = safeJson({
      command: "printf '%s\\n' 'external-client'",
      description: '列出可用工具命名空间'
    });
  } else if (encodedName === 'listNamespaceTools' && available('Bash')) {
    name = 'Bash';
    const names = [...state.originalToEncoded.keys()].sort();
    argumentsText = safeJson({
      command: `printf '%s\\n' ${names.map(shellQuote).join(' ')}`,
      description: '列出客户端可用工具'
    });
  }

  // Claude Code rejects an empty pages value even though some upstream models
  // include it for ordinary text files. Remove only the invalid empty value.
  if (name === 'Read') {
    input = parsedToolArguments(argumentsText);
    if (input && !input.pages) {
      delete input.pages;
      argumentsText = safeJson(input);
    }
  }

  // A worktree-isolated Claude subagent cannot start when the current folder
  // is not a Git repository. Isolation is optional, so let Claude Code run the
  // same Agent call in the current workspace instead of failing immediately.
  if (name === 'Agent') {
    input = parsedToolArguments(argumentsText);
    if (input?.isolation === 'worktree') {
      delete input.isolation;
      argumentsText = safeJson(input);
    }
  }

  return { ...tool, encodedName, name, arguments: argumentsText };
}

async function callPostman({ payload, protocol, state, toolResults }, handlers = {}, signal) {
  const workspaceId = discoverWorkspaceId();
  if (!workspaceId) {
    throw new GatewayError('无法识别 Postman 工作区。请使用 --workspace-id <UUID> 或设置 POSTMAN_WORKSPACE_ID', 400);
  }
  const config = await getPostmanConfig();
  const body = buildPostmanBody({ payload, protocol, config, workspaceId, state, toolResults });
  const { accessToken } = getPostmanAuthInfo();
  const response = await fetch(`${POSTMAN_GATEWAY_URL}/chat`, {
    method: 'POST',
    headers: postmanHeaders(accessToken, 'text/event-stream'),
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const text = await response.text();
    throw new GatewayError(`Postman Chat 返回 HTTP ${response.status}: ${text.slice(0, 500)}`, 502);
  }
  if (!response.body) throw new GatewayError('Postman Chat 没有返回响应流', 502);
  handlers.onStart?.({ model: body.devModeOptions.selectedModel || config.defaultModel || payload.model || 'postbot' });

  const result = {
    text: '',
    conversationId: state.conversationId,
    model: body.devModeOptions.selectedModel || config.defaultModel || payload.model || 'postbot',
    usage: null,
    approval: null,
    toolCallMap: new Map(),
    toolCalls: []
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
      sessionStore.updateConversation(state, result.conversationId);
      handlers.onConversation?.(event.data || {});
    } else if (event.eventType === 'textChunk') {
      const text = event.data?.textContent || event.data?.content || event.data?.text || '';
      if (text) {
        result.text += text;
        handlers.onText?.(text);
      }
    } else if (event.eventType === 'toolCall' || event.eventType === 'toolCallChunk') {
      for (const [index, raw] of (event.data?.toolCalls || []).entries()) {
        mergePostmanToolCall(result, raw, event.eventType, index);
      }
    } else if (event.eventType === 'usage') {
      result.usage = event.data || null;
    } else if (event.eventType === 'loopApprovalChunk') {
      result.approval = event.data || {};
    } else if (event.eventType === 'failure') {
      const failure = event.data || {};
      if (DEBUG) {
        console.warn(`[Postman Gateway Debug] failure-event=${safeJson(failure).slice(0, 4000)}`);
      }
      throw postmanFailureError(failure);
    }
  });
  result.toolCalls = [...result.toolCallMap.values()]
    .sort((a, b) => a.index - b.index)
    .map((tool) => normalizePostmanToolCall(state, tool));
  delete result.toolCallMap;
  if (result.approval && !result.toolCalls.length && !result.text) {
    result.text = 'Postman 请求继续执行前需要批准，但上游未返回可供客户端执行的工具调用。请重新发送请求。';
  }
  handlers.onEnd?.(result);
  return result;
}

async function normalizeAnthropicAutoModeWithRepair(payload, result, state, signal, postmanCaller = callPostman) {
  try {
    return normalizeAnthropicAutoModeResult(payload, 'anthropic', result);
  } catch (error) {
    if (error?.code !== 'invalid_auto_mode_classifier_output') throw error;
    if (!state?.conversationId) throw error;
    console.warn('[Postman Gateway] Auto mode XML 无效，正在沿用同一 Postman 会话纠正一次');
    const repairPayload = autoModeClassifierRepairPayload(payload, 'anthropic');
    const repaired = await postmanCaller({
      payload: repairPayload,
      protocol: 'anthropic',
      state,
      toolResults: []
    }, {}, signal);
    const normalized = normalizeAnthropicAutoModeResult(payload, 'anthropic', repaired);
    console.log('[Postman Gateway] Auto mode XML 同会话纠正成功');
    return normalized;
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || '').length / 4));
}

function requestInputText(payload, protocol) {
  return `${systemText(payload, protocol)}\n${latestUserText(payload, protocol)}`;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function apiError(res, error, protocol) {
  const status = error.status || 502;
  const message = error.message || String(error);
  if (res.headersSent) {
    if (!res.writableEnded) {
      if (protocol === 'anthropic') {
        res.end(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message } })}\n\n`);
      } else {
        res.end(`data: ${JSON.stringify({ error: { message, type: error.code || 'postman_gateway_error' } })}\n\n`);
      }
    }
    return;
  }
  if (protocol === 'anthropic') {
    json(res, status, { type: 'error', error: { type: 'api_error', message } });
  } else {
    json(res, status, { error: { message, type: error.code || 'postman_gateway_error' } });
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 20 * 1024 * 1024) throw new GatewayError('请求体超过 20 MB', 413, 'request_too_large');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new GatewayError('请求体不是有效 JSON', 400, 'invalid_json');
  }
}

function prepareRequest(payload, protocol, req) {
  const resolved = sessionStore.resolve(payload, protocol, req);
  const toolSet = buildToolSet(payload, protocol);
  sessionStore.configureTools(resolved.state, toolSet);
  return { ...resolved, toolSet };
}

function openAIUsage(payload, result) {
  const prompt = estimateTokens(requestInputText(payload, 'openai'));
  const completion = estimateTokens(result.text) + estimateTokens(result.toolCalls.map((tool) => tool.arguments).join(''));
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

async function handleOpenAI(payload, req, res, abortController) {
  const { state, reused, toolResults } = prepareRequest(payload, 'openai', req);
  const stream = payload.stream === true;
  const id = `chatcmpl-postman-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let result;
  if (!stream) {
    result = await callPostman({ payload, protocol: 'openai', state, toolResults }, {}, abortController.signal);
    sessionStore.completeToolResults(state, toolResults);
    sessionStore.registerResult(state, payload, 'openai', result);
    const message = { role: 'assistant', content: result.text || null };
    if (result.toolCalls.length) {
      message.tool_calls = result.toolCalls.map((tool) => ({
        id: tool.id,
        type: 'function',
        function: { name: tool.name, arguments: tool.arguments }
      }));
    }
    return json(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: result.model,
      choices: [{ index: 0, message, finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop' }],
      usage: openAIUsage(payload, result)
    });
  }

  let started = false;
  result = await callPostman({ payload, protocol: 'openai', state, toolResults }, {
    onStart: ({ model }) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      started = true;
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);
    },
    onText: (text) => {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model || 'postbot', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
    }
  }, abortController.signal);
  sessionStore.completeToolResults(state, toolResults);
  sessionStore.registerResult(state, payload, 'openai', result);
  for (const [index, tool] of result.toolCalls.entries()) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [{ index: 0, delta: { tool_calls: [{ index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] }, finish_reason: null }] })}\n\n`);
  }
  if (started && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [{ index: 0, delta: {}, finish_reason: result.toolCalls.length ? 'tool_calls' : 'stop' }] })}\n\n`);
    if (payload.stream_options?.include_usage) {
      res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: result.model, choices: [], usage: openAIUsage(payload, result) })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  }
  if (DEBUG) console.log(`[Postman Gateway Debug] OpenAI session=${state.id.slice(0, 8)} reused=${reused}`);
}

function anthropicUsage(payload, result) {
  return {
    input_tokens: estimateTokens(requestInputText(payload, 'anthropic')),
    output_tokens: estimateTokens(result.text) + estimateTokens(result.toolCalls.map((tool) => tool.arguments).join(''))
  };
}

async function handleAnthropic(payload, req, res, abortController) {
  const { state, reused, toolResults } = prepareRequest(payload, 'anthropic', req);
  const stream = payload.stream === true;
  const structured = getAnthropicStructuredOutput(payload);
  const id = `msg_postman_${crypto.randomUUID().replace(/-/g, '')}`;
  let result;
  if (!stream) {
    result = await callPostman({ payload, protocol: 'anthropic', state, toolResults }, {}, abortController.signal);
    result = normalizeAnthropicStructuredResult(payload, result);
    result = await normalizeAnthropicAutoModeWithRepair(payload, result, state, abortController.signal);
    sessionStore.completeToolResults(state, toolResults);
    sessionStore.registerResult(state, payload, 'anthropic', result);
    const content = [];
    if (result.text) content.push({ type: 'text', text: result.text });
    for (const tool of result.toolCalls) {
      let input;
      try { input = JSON.parse(tool.arguments); } catch { input = { input: tool.arguments }; }
      content.push({ type: 'tool_use', id: tool.id, name: tool.name, input });
    }
    return json(res, 200, {
      id,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content,
      stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: anthropicUsage(payload, result)
    });
  }

  if (structured) {
    result = await callPostman({ payload, protocol: 'anthropic', state, toolResults }, {}, abortController.signal);
    result = normalizeAnthropicStructuredResult(payload, result);
    result = await normalizeAnthropicAutoModeWithRepair(payload, result, state, abortController.signal);
    sessionStore.completeToolResults(state, toolResults);
    sessionStore.registerResult(state, payload, 'anthropic', result);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: result.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(requestInputText(payload, 'anthropic')), output_tokens: 0 } } })}\n\n`);
    let nextIndex = 0;
    if (result.text) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: nextIndex, content_block: { type: 'text', text: '' } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: nextIndex, delta: { type: 'text_delta', text: result.text } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: nextIndex })}\n\n`);
      nextIndex += 1;
    }
    for (const tool of result.toolCalls) {
      res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: nextIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: nextIndex, delta: { type: 'input_json_delta', partial_json: tool.arguments } })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: nextIndex })}\n\n`);
      nextIndex += 1;
    }
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: anthropicUsage(payload, result).output_tokens } })}\n\n`);
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    if (DEBUG) console.log(`[Postman Gateway Debug] Anthropic structured session=${state.id.slice(0, 8)} reused=${reused}`);
    return;
  }

  let started = false;
  let textIndex = -1;
  result = await callPostman({ payload, protocol: 'anthropic', state, toolResults }, {
    onStart: ({ model }) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      started = true;
      res.write(`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: estimateTokens(requestInputText(payload, 'anthropic')), output_tokens: 0 } } })}\n\n`);
    },
    onText: (text) => {
      if (textIndex === -1) {
        textIndex = 0;
        res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } })}\n\n`);
      }
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text } })}\n\n`);
    }
  }, abortController.signal);
  sessionStore.completeToolResults(state, toolResults);
  sessionStore.registerResult(state, payload, 'anthropic', result);
  if (textIndex !== -1) {
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: textIndex })}\n\n`);
  }
  let nextIndex = textIndex === -1 ? 0 : textIndex + 1;
  for (const tool of result.toolCalls) {
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: nextIndex, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })}\n\n`);
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: nextIndex, delta: { type: 'input_json_delta', partial_json: tool.arguments } })}\n\n`);
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: nextIndex })}\n\n`);
    nextIndex += 1;
  }
  if (started && !res.writableEnded) {
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: result.toolCalls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: anthropicUsage(payload, result).output_tokens } })}\n\n`);
    res.end(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  }
  if (DEBUG) console.log(`[Postman Gateway Debug] Anthropic session=${state.id.slice(0, 8)} reused=${reused}`);
}

function responsesUsage(payload, result) {
  const input = estimateTokens(requestInputText(payload, 'responses'));
  const output = estimateTokens(result.text) + estimateTokens(result.toolCalls.map((tool) => tool.arguments).join(''));
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output
  };
}

function responseOutputItems(responseId, result) {
  const output = [];
  if (result.text) {
    output.push({
      id: `msg_${sha(`${responseId}:text`).slice(0, 24)}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: result.text, annotations: [], logprobs: [] }]
    });
  }
  for (const tool of result.toolCalls) {
    output.push({
      id: `fc_${sha(tool.id).slice(0, 24)}`,
      type: 'function_call',
      status: 'completed',
      call_id: tool.id,
      name: tool.name,
      arguments: tool.arguments
    });
  }
  return output;
}

function responseObject(id, payload, result, status = 'completed') {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: payload.instructions || null,
    max_output_tokens: payload.max_output_tokens || null,
    model: result.model || payload.model || 'postbot',
    output: status === 'completed' ? responseOutputItems(id, result) : [],
    parallel_tool_calls: payload.parallel_tool_calls !== false,
    previous_response_id: payload.previous_response_id || null,
    reasoning: payload.reasoning || { effort: null, summary: null },
    store: false,
    temperature: payload.temperature ?? null,
    text: payload.text || { format: { type: 'text' } },
    tool_choice: payload.tool_choice || 'auto',
    tools: payload.tools || [],
    top_p: payload.top_p ?? null,
    truncation: payload.truncation || 'disabled',
    usage: status === 'completed' ? responsesUsage(payload, result) : null,
    user: payload.user || null,
    metadata: payload.metadata || {}
  };
}

function codexModelInfo(slug, displayName, priority) {
  return {
    slug,
    prefer_websockets: false,
    support_verbosity: false,
    default_verbosity: 'low',
    apply_patch_tool_type: 'freeform',
    web_search_tool_type: 'text_and_image',
    input_modalities: ['text'],
    supports_image_detail_original: false,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: true,
    tool_mode: 'direct',
    multi_agent_version: 'v1',
    use_responses_lite: false,
    include_skills_usage_instructions: true,
    include_plugin_usage_instructions: true,
    include_apps_usage_instructions: true,
    auto_review_model_override: null,
    context_window: 200000,
    max_context_window: 200000,
    auto_compact_token_limit: null,
    comp_hash: `postman-${APP_VERSION}`,
    base_instructions: 'You are a coding agent. Follow the client instructions and use the provided tools when needed.',
    reasoning_summary_format: 'experimental',
    default_reasoning_summary: 'none',
    display_name: displayName,
    description: 'Model provided through the local Postman Agent gateway.',
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Faster responses with lighter reasoning' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Deeper reasoning for complex tasks' }
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    minimal_client_version: '0.0.0',
    supported_in_api: true,
    availability_nux: null,
    upgrade: null,
    priority,
    model_messages: null,
    experimental_supported_tools: [],
    available_in_plans: [],
    supports_search_tool: false,
    default_service_tier: null,
    service_tiers: [],
    additional_speed_tiers: [],
    supports_reasoning_summaries: false
  };
}

function codexModelCatalog(config) {
  return [
    codexModelInfo('postbot', 'Postman Default', 0),
    ...(config.models || []).map((model, index) =>
      codexModelInfo(model.key, model.displayName || model.key, index + 1))
  ];
}

function writeResponseEvent(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function handleResponses(payload, req, res, abortController) {
  const { state, reused, toolResults } = prepareRequest(payload, 'responses', req);
  const stream = payload.stream === true;
  const id = `resp_postman_${crypto.randomUUID().replace(/-/g, '')}`;
  if (!stream) {
    const result = await callPostman({ payload, protocol: 'responses', state, toolResults }, {}, abortController.signal);
    sessionStore.completeToolResults(state, toolResults);
    sessionStore.registerResult(state, payload, 'responses', result, id);
    return json(res, 200, responseObject(id, payload, result));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const emptyResult = { model: payload.model || 'postbot', text: '', toolCalls: [] };
  writeResponseEvent(res, { type: 'response.created', response: responseObject(id, payload, emptyResult, 'in_progress'), sequence_number: 0 });
  writeResponseEvent(res, { type: 'response.in_progress', response: responseObject(id, payload, emptyResult, 'in_progress'), sequence_number: 1 });
  const result = await callPostman({ payload, protocol: 'responses', state, toolResults }, {}, abortController.signal);
  sessionStore.completeToolResults(state, toolResults);
  sessionStore.registerResult(state, payload, 'responses', result, id);
  const items = responseOutputItems(id, result);
  let sequence = 2;
  for (const [outputIndex, item] of items.entries()) {
    if (item.type === 'message') {
      const added = { ...item, status: 'in_progress', content: [] };
      writeResponseEvent(res, { type: 'response.output_item.added', response_id: id, output_index: outputIndex, item: added, sequence_number: sequence++ });
      const part = { type: 'output_text', text: '', annotations: [], logprobs: [] };
      writeResponseEvent(res, { type: 'response.content_part.added', response_id: id, item_id: item.id, output_index: outputIndex, content_index: 0, part, sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.output_text.delta', response_id: id, item_id: item.id, output_index: outputIndex, content_index: 0, delta: result.text, logprobs: [], sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.output_text.done', response_id: id, item_id: item.id, output_index: outputIndex, content_index: 0, text: result.text, logprobs: [], sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.content_part.done', response_id: id, item_id: item.id, output_index: outputIndex, content_index: 0, part: item.content[0], sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.output_item.done', response_id: id, output_index: outputIndex, item, sequence_number: sequence++ });
    } else {
      const added = { ...item, status: 'in_progress', arguments: '' };
      writeResponseEvent(res, { type: 'response.output_item.added', response_id: id, output_index: outputIndex, item: added, sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.function_call_arguments.delta', response_id: id, item_id: item.id, output_index: outputIndex, delta: item.arguments, sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.function_call_arguments.done', response_id: id, item_id: item.id, output_index: outputIndex, arguments: item.arguments, sequence_number: sequence++ });
      writeResponseEvent(res, { type: 'response.output_item.done', response_id: id, output_index: outputIndex, item, sequence_number: sequence++ });
    }
  }
  writeResponseEvent(res, { type: 'response.completed', response: responseObject(id, payload, result), sequence_number: sequence });
  res.end('data: [DONE]\n\n');
  if (DEBUG) console.log(`[Postman Gateway Debug] Responses session=${state.id.slice(0, 8)} reused=${reused}`);
}

function printHelp() {
  console.log(`
Postman Postbot Agent 真实转发网关（macOS / Windows / Linux）

用法:
  node postman-gateway-macos.js [选项]

选项:
  -h, --help                    显示帮助
  -p, --port <number>           监听端口，默认 9887
  -H, --host <address>          绑定地址，默认 127.0.0.1
  -d, --postman-data-dir <path> Postman 用户数据目录
  -w, --workspace-id <uuid>     Postman 工作区；默认从客户端日志自动识别

接口:
  GET  /                         健康状态
  GET  /v1/models                真实可用模型
  POST /v1/chat/completions      OpenAI Chat Completions（Trae）
  POST /v1/messages              Anthropic Messages（Claude Code）
  POST /v1/messages/count_tokens Anthropic Token Count
  POST /v1/responses             OpenAI Responses（Codex CLI）

Agent 能力:
  会话复用、增量消息、function/tool 调用、客户端审批、toolResponse 回传。

注意:
  该网关使用 Postman 桌面端的内部接口，可能随 Postman 更新而变化。
  默认仅监听本机，不会输出登录令牌或完整提示词。
`);
}

function validateRuntime() {
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new GatewayError(`无效端口: ${PORT}`, 400);
  if (!Number.isInteger(MAX_QUERY_CHARS) || MAX_QUERY_CHARS < 1000) throw new GatewayError('POSTMAN_MAX_QUERY_CHARS 必须至少为 1000', 400);
}

function createServer() {
  return http.createServer(async (req, res) => {
    const route = req.url.split('?')[0];
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version, anthropic-beta, x-api-key, x-session-id, x-postman-session-id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    let protocol = route === '/v1/messages' || route === '/v1/messages/count_tokens'
      ? 'anthropic'
      : route === '/v1/responses' ? 'responses' : 'openai';
    try {
      if (req.method === 'GET' && route === '/') {
        return json(res, 200, {
          status: 'ok',
          mode: 'real-postman-agent-forwarding',
          platform: PLATFORM,
          postmanVersion: APP_VERSION,
          workspaceDetected: Boolean(discoverWorkspaceId()),
          capabilities: {
            conversationReuse: true,
            toolCalling: true,
            toolResponse: true,
            clientSideApproval: true,
            openaiChatCompletions: true,
            anthropicMessages: true,
            openaiResponses: true
          },
          activeSessions: sessionStore.states.size
        });
      }

      if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
        const config = await getPostmanConfig();
        const data = (config.models || []).map((model) => ({
          id: model.key,
          object: 'model',
          created: 0,
          owned_by: 'postman-postbot',
          display_name: model.displayName
        }));
        return json(res, 200, {
          object: 'list',
          data,
          // Codex CLI uses a richer model catalog envelope than the standard
          // OpenAI list. Supplying both keeps the endpoint compatible with both.
          models: codexModelCatalog(config),
          default_model: config.defaultModel,
          usage: config.usage
        });
      }

      if (req.method === 'POST' && route === '/v1/messages/count_tokens') {
        const payload = await readJsonBody(req);
        return json(res, 200, { input_tokens: estimateTokens(requestInputText(payload, 'anthropic')) });
      }

      if (req.method === 'POST' && ['/v1/chat/completions', '/v1/messages', '/v1/responses'].includes(route)) {
        const payload = await readJsonBody(req);
        const abortController = new AbortController();
        res.on('close', () => {
          if (!res.writableEnded) abortController.abort();
        });
        const toolCount = Array.isArray(payload.tools) ? payload.tools.length : 0;
        const latest = latestUserText(payload, protocol);
        console.log(`[Postman Gateway] ${route} model=${payload.model || 'postbot'} userChars=${latest.length} tools=${toolCount} stream=${payload.stream === true}`);
        if (route === '/v1/messages') return await handleAnthropic(payload, req, res, abortController);
        if (route === '/v1/responses') return await handleResponses(payload, req, res, abortController);
        return await handleOpenAI(payload, req, res, abortController);
      }

      return json(res, 404, { error: { message: 'Endpoint not found', type: 'not_found' } });
    } catch (error) {
      if (error.name === 'AbortError') {
        if (DEBUG) console.warn('[Postman Gateway] 客户端已断开');
        return;
      }
      console.error('[Postman Gateway Error]', error.message);
      apiError(res, error, protocol);
    }
  });
}

async function start() {
  validateRuntime();
  const server = createServer();
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
    console.log(' 🚀 Postman Postbot Agent 真实转发网关已启动');
    console.log('-----------------------------------------------------------------');
    console.log(` 监听地址: http://${HOST}:${PORT}`);
    console.log(` 系统平台: ${process.platform} (${process.arch}) / ${PLATFORM}`);
    console.log(` Postman 版本: ${APP_VERSION}`);
    console.log(` 登录信息: ${accountReady ? '✅ 已读取（令牌不会输出）' : '❌ 未读取'}`);
    console.log(` 工作区: ${discoverWorkspaceId() ? '✅ 已自动识别' : '❌ 未识别，请传入 --workspace-id'}`);
    console.log(` 模型配置: ${modelSummary}`);
    console.log(' Agent 协议: ✅ 会话复用 / 工具调用 / toolResponse / 客户端审批');
    console.log(' 客户端接口: ✅ Claude Code / Codex CLI / Trae');
    console.log(' 转发模式: ✅ gateway.postman.com/chat 真实请求');
    console.log('=================================================================');
  });
  return server;
}

if (require.main === module) {
  if (showHelp) {
    printHelp();
  } else {
    start().catch((error) => {
      console.error('[Postman Gateway Fatal]', error.message);
      process.exitCode = 1;
    });
  }
}

module.exports = {
  GatewayError,
  SessionStore,
  autoModeClassifierRepairPayload,
  buildPostmanBody,
  buildToolSet,
  codexModelCatalog,
  contentToText,
  createServer,
  extractToolResults,
  fitQuery,
  getAnthropicStructuredOutput,
  isClaudeCodeAutoModeClassifier,
  normalizeAnthropicAutoModeResult,
  normalizeAnthropicAutoModeWithRepair,
  normalizeAnthropicStructuredResult,
  normalizePostmanToolCall,
  normalizeToolDefinitions,
  postmanFailureError,
  printHelp,
  responseObject,
  sessionStore,
  start
};
