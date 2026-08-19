'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SessionStore,
  buildPostmanBody,
  buildToolSet,
  codexModelCatalog,
  extractToolResults,
  fitQuery,
  getAnthropicStructuredOutput,
  isClaudeCodeAutoModeClassifier,
  normalizeAnthropicAutoModeResult,
  normalizeAnthropicStructuredResult,
  normalizePostmanToolCall,
  responseObject
} = require('../postman-gateway-macos');

function testSessionStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'postman-gateway-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new SessionStore(path.join(directory, 'sessions.json'));
}

test('fitQuery keeps Postman query below the verified hard limit', () => {
  const query = fitQuery('S'.repeat(9000), `important-start\n${'U'.repeat(12000)}\nimportant-end`, true);
  assert.ok(query.length <= 9800);
  assert.match(query, /important-end$/);
});

test('fitQuery preserves the tail contract of oversized system prompts', () => {
  const system = [
    'You are a security monitor for autonomous AI coding agents.',
    'P'.repeat(110000),
    '## Output Format',
    'If allowed, return exactly <block>no</block>.'
  ].join('\n');
  const query = fitQuery(system, 'Classify this Write action.', true);
  assert.ok(query.length <= 9800);
  assert.match(query, /You are a security monitor/);
  assert.match(query, /系统提示中段已由网关截断/);
  assert.match(query, /## Output Format/);
  assert.match(query, /<block>no<\/block>/);
  assert.match(query, /Classify this Write action\.$/);
});

test('Claude Code Auto mode requests receive a final XML-only contract', () => {
  const payload = {
    model: 'claude-sonnet-5',
    system: [
      'You are a security monitor for autonomous AI coding agents.',
      'P'.repeat(110000),
      '## Output Format',
      'If allowed, return <block>no</block>.'
    ].join('\n'),
    messages: [{ role: 'user', content: 'Bash echo safe' }]
  };
  assert.equal(isClaudeCodeAutoModeClassifier(payload, 'anthropic'), true);
  const body = buildPostmanBody({
    payload,
    protocol: 'anthropic',
    config: { models: [{ key: 'CLAUDE_46_SONNET_BEDROCK', displayName: 'Claude Sonnet 4.6' }] },
    workspaceId: 'workspace-1',
    state: { conversationId: null, product: 'workspace_v12', postmanTools: [] },
    toolResults: []
  });
  assert.match(body.input.query, /Bash echo safe/);
  assert.match(body.input.query, /CLAUDE_CODE_AUTO_MODE_RESPONSE_CONTRACT/);
  assert.match(body.input.query, /Return XML only/);
  assert.match(body.input.query, /<block>no<\/block>/);
});

test('Auto mode XML is extracted from surrounding Postman prose', () => {
  const payload = {
    system: 'You are a security monitor for autonomous AI coding agents.\n## Output Format\n<block>no</block>'
  };
  const allowed = normalizeAnthropicAutoModeResult(payload, 'anthropic', {
    text: 'The action is safe.\n<block>no</block>\nDone.',
    toolCalls: []
  });
  assert.equal(allowed.text, '<block>no</block>');

  const blocked = normalizeAnthropicAutoModeResult(payload, 'anthropic', {
    text: '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] external upload</reason>',
    toolCalls: []
  });
  assert.equal(blocked.text, '<block>yes</block><category>Data Exfiltration</category><reason>[Data Exfiltration] external upload</reason>');
});

test('Anthropic JSON schema requirements are preserved in the Postman query', () => {
  const schema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      reason: { type: 'string' }
    },
    required: ['ok', 'reason'],
    additionalProperties: false
  };
  const payload = {
    model: 'GPT_56_SOL',
    system: 'Evaluate the condition.',
    messages: [{ role: 'user', content: 'Has the goal been completed?' }],
    output_config: { format: { type: 'json_schema', schema } }
  };
  assert.deepEqual(getAnthropicStructuredOutput(payload), { schema });

  const body = buildPostmanBody({
    payload,
    protocol: 'anthropic',
    config: { models: [{ key: 'GPT_56_SOL', displayName: 'GPT-5.6 Sol' }] },
    workspaceId: 'workspace-1',
    state: { conversationId: null, product: 'workspace_v12', postmanTools: [] },
    toolResults: []
  });
  assert.match(body.input.query, /STRUCTURED_OUTPUT_REQUIRED/);
  assert.match(body.input.query, /"required":\["ok","reason"\]/);
  assert.match(body.input.query, /ONLY the JSON value/);
});

test('Claude Code goal-hook prose is normalized to its required JSON schema', () => {
  const payload = {
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            impossible: { type: 'boolean' }
          },
          required: ['ok', 'reason'],
          additionalProperties: false
        }
      }
    }
  };
  const result = normalizeAnthropicStructuredResult(payload, {
    text: 'No. The transcript contains planning only; the platform was not built.',
    toolCalls: []
  });
  assert.deepEqual(JSON.parse(result.text), {
    ok: false,
    reason: 'The transcript contains planning only; the platform was not built.'
  });
});

test('fenced structured JSON is extracted, validated, and compacted', () => {
  const payload = {
    output_format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
        additionalProperties: false
      }
    }
  };
  const result = normalizeAnthropicStructuredResult(payload, {
    text: '```json\n{"title":"Document"}\n```',
    toolCalls: []
  });
  assert.equal(result.text, '{"title":"Document"}');
});

test('tool definitions are translated and long names remain reversible', () => {
  const longName = `tool_${'x'.repeat(80)}`;
  const anthropic = buildToolSet({
    tools: [{ name: longName, description: 'test', input_schema: { type: 'object', properties: {} } }]
  }, 'anthropic');
  assert.equal(anthropic.postmanTools.length, 1);
  assert.ok(anthropic.postmanTools[0].name.length <= 64);
  assert.equal(anthropic.encodedToOriginal.get(anthropic.postmanTools[0].name), longName);

  const responses = buildToolSet({
    tools: [{ type: 'function', name: 'shell', description: 'run', parameters: { type: 'object' } }]
  }, 'responses');
  assert.equal(responses.postmanTools[0].name, 'client__shell');
});

test('tool results are recognized in all three client protocols', () => {
  assert.deepEqual(extractToolResults({ messages: [{ role: 'tool', tool_call_id: 'oa', content: 'ok' }] }, 'openai'), [
    { callId: 'oa', content: 'ok', isError: false }
  ]);
  assert.deepEqual(extractToolResults({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'an', content: 'ok' }] }] }, 'anthropic'), [
    { callId: 'an', content: 'ok', isError: false }
  ]);
  assert.deepEqual(extractToolResults({ input: [{ type: 'function_call_output', call_id: 'rs', output: 'ok' }] }, 'responses'), [
    { callId: 'rs', content: 'ok', isError: false }
  ]);
});

test('historical tool results are ignored after a new user turn', () => {
  assert.deepEqual(extractToolResults({ messages: [
    { role: 'user', content: 'run a tool' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'an-old', name: 'shell', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'an-old', content: 'done' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'finished' }] },
    { role: 'user', content: 'now answer a different question' }
  ] }, 'anthropic'), []);

  assert.deepEqual(extractToolResults({ messages: [
    { role: 'user', content: 'run a tool' },
    { role: 'assistant', tool_calls: [{ id: 'oa-old', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'oa-old', content: 'done' },
    { role: 'assistant', content: 'finished' },
    { role: 'user', content: 'now answer a different question' }
  ] }, 'openai'), []);

  assert.deepEqual(extractToolResults({ input: [
    { role: 'user', content: 'run a tool' },
    { type: 'function_call', call_id: 'rs-old', name: 'shell', arguments: '{}' },
    { type: 'function_call_output', call_id: 'rs-old', output: 'done' },
    { role: 'assistant', content: [{ type: 'output_text', text: 'finished' }] },
    { role: 'user', content: 'now answer a different question' }
  ] }, 'responses'), []);
});

test('parallel tool results are read only from the trailing current turn', () => {
  assert.deepEqual(extractToolResults({ messages: [
    { role: 'tool', tool_call_id: 'old', content: 'historical' },
    { role: 'assistant', content: 'previous answer' },
    { role: 'assistant', tool_calls: [] },
    { role: 'tool', tool_call_id: 'new-1', content: 'one' },
    { role: 'tool', tool_call_id: 'new-2', content: 'two', is_error: true }
  ] }, 'openai'), [
    { callId: 'new-1', content: 'one', isError: false },
    { callId: 'new-2', content: 'two', isError: true }
  ]);

  assert.deepEqual(extractToolResults({ input: [
    { type: 'function_call_output', call_id: 'old', output: 'historical' },
    { role: 'user', content: 'new turn' },
    { type: 'function_call_output', call_id: 'new-1', output: 'one' },
    { type: 'function_call_output', call_id: 'new-2', output: 'two', status: 'failed' }
  ] }, 'responses'), [
    { callId: 'new-1', content: 'one', isError: false },
    { callId: 'new-2', content: 'two', isError: true }
  ]);
});

test('grouped tool results use the Postman Agent TOOL_RESPONSE contract', () => {
  const state = {
    conversationId: 'conversation-1',
    product: 'workspace_tools_sdk_localmode',
    postmanTools: [],
    pendingTools: new Map([
      ['call-1', { id: 'call-1', groupId: 'group-1', name: 'shell', encodedName: 'client__shell' }]
    ])
  };
  const body = buildPostmanBody({
    payload: { model: 'postbot' },
    protocol: 'responses',
    config: { models: [], defaultModel: 'GPT_54' },
    workspaceId: 'workspace-1',
    state,
    toolResults: [{ callId: 'call-1', content: 'Tool execution denied by user', isError: true }]
  });
  assert.equal(body.input.chatType, 'TOOL_RESPONSE');
  assert.equal(body.input.conversationId, 'conversation-1');
  assert.equal(body.input.toolCallGroupId, 'group-1');
  assert.equal(body.input.toolResponses[0].toolResponseStatus, 'REJECTED');
  assert.equal(body.input.toolResponses[0].toolResponseRejectionType, 'EXPLICIT');
});

test('Claude Code subagent model aliases select the matching Postman family', () => {
  const body = buildPostmanBody({
    payload: { model: 'claude-sonnet-5' },
    protocol: 'anthropic',
    config: {
      models: [
        { key: 'GPT_56_TERRA', displayName: 'GPT-5.6 Terra' },
        { key: 'CLAUDE_46_SONNET_BEDROCK', displayName: 'Claude Sonnet 4.6' }
      ],
      defaultModel: 'GPT_56_TERRA'
    },
    workspaceId: 'workspace-1',
    state: {
      conversationId: null,
      product: 'workspace_v12',
      postmanTools: []
    },
    toolResults: []
  });
  assert.equal(body.devModeOptions.selectedModel, 'CLAUDE_46_SONNET_BEDROCK');
});

test('Trae tool call IDs are mapped back to the original Postman IDs', (t) => {
  const store = testSessionStore(t);
  const request = {
    model: 'gpt-5.5',
    messages: [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Inspect this folder.' }
    ]
  };
  const req = { headers: {} };
  const first = store.resolve(request, 'openai', req);
  store.updateConversation(first.state, 'conversation-trae');
  store.registerResult(first.state, request, 'openai', {
    text: '',
    toolCalls: [{
      id: 'call_postman_original',
      groupId: 'group-trae',
      name: 'LS',
      encodedName: 'client__LS',
      arguments: '{"path":"/tmp/example"}'
    }]
  });

  const continuation = {
    ...request,
    messages: [
      ...request.messages,
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_trae_rewritten',
          type: 'function',
          function: { name: 'LS', arguments: '{ "path": "/tmp/example" }' }
        }]
      },
      { role: 'tool', tool_call_id: 'call_trae_rewritten', content: 'file.txt' }
    ]
  };
  const resolved = store.resolve(continuation, 'openai', req);
  assert.equal(resolved.reused, true);
  assert.equal(resolved.state.id, first.state.id);
  assert.deepEqual(resolved.toolResults, [{
    callId: 'call_postman_original',
    clientCallId: 'call_trae_rewritten',
    content: 'file.txt',
    isError: false
  }]);

  const body = buildPostmanBody({
    payload: continuation,
    protocol: 'openai',
    config: { models: [{ key: 'GPT_55', displayName: 'GPT-5.5' }], defaultModel: 'GPT_54' },
    workspaceId: 'workspace-1',
    state: resolved.state,
    toolResults: resolved.toolResults
  });
  assert.equal(body.input.conversationId, 'conversation-trae');
  assert.equal(body.input.toolResponses[0].toolCallId, 'call_postman_original');
});

test('rewritten tool IDs are not matched when the tool arguments differ', (t) => {
  const store = testSessionStore(t);
  const request = { messages: [{ role: 'user', content: 'Inspect folder A.' }] };
  const req = { headers: {} };
  const first = store.resolve(request, 'openai', req);
  store.updateConversation(first.state, 'conversation-a');
  store.registerResult(first.state, request, 'openai', {
    text: '',
    toolCalls: [{ id: 'call_a', groupId: 'group-a', name: 'LS', arguments: '{"path":"/a"}' }]
  });

  const continuation = {
    messages: [
      ...request.messages,
      { role: 'assistant', tool_calls: [{ id: 'call_rewritten', type: 'function', function: { name: 'LS', arguments: '{"path":"/b"}' } }] },
      { role: 'tool', tool_call_id: 'call_rewritten', content: 'unexpected' }
    ]
  };
  const resolved = store.resolve(continuation, 'openai', req);
  assert.equal(resolved.reused, false);
  assert.notEqual(resolved.state.id, first.state.id);
});

test('Postman namespace wrappers are unwrapped to the original client tool', () => {
  const state = {
    encodedToOriginal: new Map([['client__Skill', 'Skill']]),
    originalToEncoded: new Map([['Skill', 'client__Skill']])
  };
  const normalized = normalizePostmanToolCall(state, {
    id: 'call-wrapper',
    encodedName: 'executeNamespaceTool',
    arguments: JSON.stringify({
      namespace: 'external-client',
      toolName: 'client__Skill',
      input: { skill: 'ppt-master', args: 'make slides' }
    })
  });
  assert.equal(normalized.name, 'Skill');
  assert.deepEqual(JSON.parse(normalized.arguments), { skill: 'ppt-master', args: 'make slides' });
});

test('Postman native file and shell aliases are translated for Claude Code', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([
      ['Bash', 'client__Bash'],
      ['Read', 'client__Read'],
      ['Write', 'client__Write']
    ])
  };
  const bash = normalizePostmanToolCall(state, {
    encodedName: 'executeBashCommand',
    arguments: '{"command":"pwd","isBackground":false}'
  });
  assert.equal(bash.name, 'Bash');
  assert.deepEqual(JSON.parse(bash.arguments), {
    command: 'pwd',
    description: '执行命令',
    run_in_background: false
  });

  const read = normalizePostmanToolCall(state, {
    encodedName: 'readFile',
    arguments: '{"filePath":"/tmp/a.txt","offset":1,"limit":20,"pages":""}'
  });
  assert.equal(read.name, 'Read');
  assert.deepEqual(JSON.parse(read.arguments), { file_path: '/tmp/a.txt', offset: 1, limit: 20 });

  const write = normalizePostmanToolCall(state, {
    encodedName: 'createFile',
    arguments: '{"filePath":"/tmp/a.txt","contents":"hello"}'
  });
  assert.equal(write.name, 'Write');
  assert.deepEqual(JSON.parse(write.arguments), { file_path: '/tmp/a.txt', content: 'hello' });
});

test('Postman searchInFiles is converted to a Claude Code Grep call', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([
      ['Grep', 'client__Grep'],
      ['Bash', 'client__Bash']
    ])
  };
  const normalized = normalizePostmanToolCall(state, {
    id: 'call-search',
    encodedName: 'searchInFiles',
    arguments: JSON.stringify({
      query: 'OpenAI-compatible (v2)+',
      isRegex: false,
      fileNamePatterns: [
        '/Users/leefee/deepseek-harness/docs/**/*.md',
        '/Users/leefee/deepseek-harness/apps/**/*.md',
        '/Users/leefee/deepseek-harness/python/**/*.md'
      ]
    })
  });
  assert.equal(normalized.id, 'call-search');
  assert.equal(normalized.name, 'Grep');
  assert.deepEqual(JSON.parse(normalized.arguments), {
    pattern: 'OpenAI-compatible \\(v2\\)\\+',
    path: '/Users/leefee/deepseek-harness',
    glob: '{docs/**/*.md,apps/**/*.md,python/**/*.md}',
    output_mode: 'content',
    '-n': true,
    head_limit: 200
  });
});

test('Postman searchInFiles preserves regex and search options', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([['Grep', 'client__Grep']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'searchInFiles',
    arguments: JSON.stringify({
      query: 'OpenAI\\s+compatible',
      isRegex: true,
      isCaseSensitive: false,
      maxResults: 50,
      fileNamePatterns: ['/tmp/docs/**/*.md']
    })
  });
  assert.equal(normalized.name, 'Grep');
  assert.deepEqual(JSON.parse(normalized.arguments), {
    pattern: 'OpenAI\\s+compatible',
    path: '/tmp/docs',
    glob: '**/*.md',
    output_mode: 'content',
    '-n': true,
    '-i': true,
    head_limit: 50
  });
});

test('Postman searchInFiles falls back to a safely quoted rg command', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([['Bash', 'client__Bash']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'searchInFiles',
    arguments: JSON.stringify({
      query: "writer's + draft",
      isRegex: false,
      limit: 25,
      fileNamePatterns: ['/tmp/a project/docs/**/*.md']
    })
  });
  const input = JSON.parse(normalized.arguments);
  assert.equal(normalized.name, 'Bash');
  assert.equal(input.description, '搜索文件内容');
  assert.match(input.command, /rg --line-number/);
  assert.match(input.command, /--fixed-strings/);
  assert.match(input.command, /--glob '\*\*\/\*\.md'/);
  assert.match(input.command, /writer/);
  assert.match(input.command, /sed -n '1,25p'/);
});

test('blank pages are removed from direct Claude Code Read calls', () => {
  const state = {
    encodedToOriginal: new Map([['client__Read', 'Read']]),
    originalToEncoded: new Map([['Read', 'client__Read']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'client__Read',
    arguments: '{"file_path":"/tmp/a.txt","offset":0,"limit":100,"pages":""}'
  });
  assert.equal(normalized.name, 'Read');
  assert.deepEqual(JSON.parse(normalized.arguments), { file_path: '/tmp/a.txt', offset: 0, limit: 100 });
});

test('Postman namespace tool listing is converted to a safe client Bash call', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([
      ['Bash', 'client__Bash'],
      ['Read', 'client__Read']
    ])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'listNamespaceTools',
    arguments: '{"namespace":"external-client"}'
  });
  assert.equal(normalized.name, 'Bash');
  assert.match(JSON.parse(normalized.arguments).command, /Bash/);
  assert.match(JSON.parse(normalized.arguments).command, /Read/);
});

test('Postman listDirectory is converted to a bounded client Bash call', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([['Bash', 'client__Bash']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'listDirectory',
    arguments: JSON.stringify({
      directoryPath: "/tmp/a directory's files",
      depth: 2,
      ignoreGlobs: ['node_modules/*']
    })
  });
  const input = JSON.parse(normalized.arguments);
  assert.equal(normalized.name, 'Bash');
  assert.match(input.command, /-maxdepth 2/);
  assert.match(input.command, /node_modules/);
  assert.equal(input.description, '读取目录内容');
});

test('Postman namespace listing is converted to a safe client Bash call', () => {
  const state = {
    encodedToOriginal: new Map(),
    originalToEncoded: new Map([['Bash', 'client__Bash']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'listNamespaces',
    arguments: '{}'
  });
  assert.equal(normalized.name, 'Bash');
  assert.match(JSON.parse(normalized.arguments).command, /external-client/);
});

test('Claude Agent calls drop optional worktree isolation outside repositories', () => {
  const state = {
    encodedToOriginal: new Map([['client__Agent', 'Agent']]),
    originalToEncoded: new Map([['Agent', 'client__Agent']])
  };
  const normalized = normalizePostmanToolCall(state, {
    encodedName: 'client__Agent',
    arguments: JSON.stringify({
      description: 'Make slides',
      prompt: 'Generate the deck',
      subagent_type: 'general-purpose',
      isolation: 'worktree',
      run_in_background: true
    })
  });
  assert.equal(normalized.name, 'Agent');
  assert.deepEqual(JSON.parse(normalized.arguments), {
    description: 'Make slides',
    prompt: 'Generate the deck',
    subagent_type: 'general-purpose',
    run_in_background: true
  });
});

test('Responses output exposes Postman calls as function_call items', () => {
  const result = {
    model: 'GPT_54',
    text: '',
    toolCalls: [{ id: 'call-9', name: 'shell', arguments: '{"command":"pwd"}' }]
  };
  const response = responseObject('resp-1', { model: 'postbot', tools: [] }, result);
  assert.equal(response.output[0].type, 'function_call');
  assert.equal(response.output[0].call_id, 'call-9');
  assert.equal(response.output[0].name, 'shell');
});

test('Codex model catalog contains a usable postbot alias', () => {
  const models = codexModelCatalog({ models: [{ key: 'GPT_54', displayName: 'GPT-5.4' }] });
  assert.equal(models[0].slug, 'postbot');
  assert.equal(models[0].tool_mode, 'direct');
  assert.equal(models[1].slug, 'GPT_54');
});
