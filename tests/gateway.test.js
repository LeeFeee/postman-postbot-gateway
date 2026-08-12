'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPostmanBody,
  buildToolSet,
  codexModelCatalog,
  extractToolResults,
  fitQuery,
  responseObject
} = require('../postman-gateway-macos');

test('fitQuery keeps Postman query below the verified hard limit', () => {
  const query = fitQuery('S'.repeat(9000), `important-start\n${'U'.repeat(12000)}\nimportant-end`, true);
  assert.ok(query.length <= 9800);
  assert.match(query, /important-end$/);
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
