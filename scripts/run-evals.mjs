import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTsLoader } from './lib/load-typescript.mjs';

const read = file => JSON.parse(fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const executedTools = [];
const requests = [];
let chunks = [];
const load = createTsLoader({
  '@langchain/ollama': {}, '@langchain/core/messages': {},
  './tools': { allTools: [] }, './tools/policy': { summarizeToolPolicies: () => '' },
  '../tools/policy': { toolPolicies: {} },
  './runtime/trace': { createTraceId: () => 'eval', recordTrace: () => {} },
  './runtime/ToolExecutor': { executeTool: async (name, args) => { executedTools.push({ name, args }); return { result: '模拟工具返回的事实' }; } },
  './rag': { retrieveRelevantChunks: async () => chunks, listRagFiles: () => [{ id: 'active', name: '项目总结.md' }, { id: 'removed', name: '已移除文档.md' }] },
  './openaiCompatible': {
    OPENAI_COMPATIBLE_TOOLS: [], buildCompatibleUserContent: text => text,
    invokeOpenAICompatibleChat: async options => { requests.push(options); return { content: '模拟模型回答', toolCalls: [] }; },
    streamOpenAICompatibleChat: async options => { requests.push(options); options.onToken('模拟模型回答'); return '模拟模型回答'; },
  },
});
const { resolveRouteDecision } = load('src/main/routing.ts');
const agent = load('src/main/agent.ts');
agent.applyModelSettings({ agentProvider: 'openai-compatible', ragProvider: 'openai-compatible', online: { baseUrl: 'https://mock.invalid/v1', apiKey: 'mock' } });

for (const item of read('evals/agent-routing.json')) {
  const options = item.context ?? {};
  const decision = resolveRouteDecision(item.input, options);
  const route = options.useRag ? 'rag' : decision.useTools || decision.useAdvancedModel ? 'agent' : 'chat';
  assert.equal(route, item.expectedRoute, `${item.id}: wrong production route`);
  executedTools.length = 0;
  if (item.expectedTools?.length) {
    await agent.chatWithAgent([], item.input, () => {}, () => {}, () => {});
    for (const expected of item.expectedTools) assert.ok(executedTools.some(t => t.name === expected), `${item.id}: missing actual tool dispatch ${expected}`);
  }
  if (item.expectedExpression) assert.equal(executedTools.find(t => t.name === 'calculator')?.args.expression, item.expectedExpression);
  console.log(`✓ ${item.id}: route ${route}${executedTools.length ? ', tools ' + executedTools.map(t => t.name).join(', ') : ''}`);
}

for (const item of read('evals/rag-citations.json')) {
  chunks = item.chunks;
  requests.length = 0;
  await agent.chatWithRag([{ role: 'assistant', content: '已移除文档中的旧结论' }], item.question, ['active'], () => {});
  const messages = requests.at(-1).messages;
  const prompt = messages.map(m => m.content).join('\n');
  for (const expected of item.expectedPromptIncludes) assert.ok(prompt.includes(expected), `${item.id}: missing RAG prompt contract ${expected}`);
  assert.ok(!prompt.includes('已移除文档中的旧结论'), `${item.id}: stale assistant history leaked`);
  assert.ok(!prompt.includes('已移除文档.md'), `${item.id}: removed file leaked`);
  console.log(`✓ ${item.id}: actual RAG context and citation instructions`);
}
console.log('Deterministic behavior evals passed (model and external I/O mocked; answer quality is not evaluated).');
