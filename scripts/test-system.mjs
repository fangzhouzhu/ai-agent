import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createTsLoader } from './lib/load-typescript.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centibot-system-check-'))
after(() => {
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(root, { recursive: true, force: true })
})
let sequence = 0
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  assert.ok(check(), 'Expected state was not reached')
}
function environment(overrides = {}) {
  const dir = path.join(root, String(sequence++))
  fs.mkdirSync(dir)
  const events = []
  const webContents = Object.assign(new EventEmitter(), { id: sequence, isDestroyed: () => false,
    send: (channel, data) => events.push({ channel, data }) })
  const mocks = {
    electron: { app: { getPath: () => dir }, BrowserWindow: { getAllWindows: () => [{ webContents }] } },
    './runtime/logger': { writeAppLog: () => {} },
    './tools/policy': { getDefaultArtifactDir: () => path.join(dir, 'artifacts') },
    '../tools/policy': { toolPolicies: { write_file: { displayName: '写入文件', requiresConfirmation: true } } },
    '../tools': { allTools: [] },
    // These tests use fake tools without filesystem behavior. Real workspace
    // and revision integration is covered by test-file-safety.mjs.
    './fileOperations': { prepareFileOperation: () => null, validateFileOperation: () => {}, backupFileOperation: () => [], withFileOperationLock: work => work() },
    './agent': { getAgentProvider: () => 'openai-compatible', getAgentModel: () => 'mock', getOnlineSettings: () => ({ baseUrl: 'https://mock.invalid', apiKey: 'mock' }) },
    ...overrides,
  }
  return { dir, events, webContents, load: createTsLoader(mocks) }
}

test('failed disk write keeps committed configuration and clears speculative cache', async () => {
  let fail = false
  const fakeFs = { ...fs, promises: { ...fs.promises, writeFile: (...args) => fail ? Promise.reject(new Error('disk full')) : fs.promises.writeFile(...args) } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const store = load('src/main/storage.ts')
  await store.saveModelSettings({ chatModel: 'old' })
  fail = true
  await assert.rejects(store.saveModelSettings({ chatModel: 'new' }), /disk full/)
  assert.equal(store.getModelSettings().chatModel, 'old')
  fail = false
  await store.saveModelSettings({ agentModel: 'independent-update' })
  assert.equal(store.getModelSettings().chatModel, 'old', 'A later patch must not resurrect a failed patch')
  await store.saveModelSettings({ chatModel: 'recovered' })
  assert.equal(store.getModelSettings().chatModel, 'recovered')
})

test('concurrent settings patches are retained and corrupt JSON recovers previous version', async () => {
  const { dir, load } = environment()
  const store = load('src/main/storage.ts')
  await Promise.all([store.saveModelSettings({ chatModel: 'one' }), store.saveModelSettings({ agentModel: 'two' })])
  assert.equal(store.getModelSettings().chatModel, 'one')
  assert.equal(store.getModelSettings().agentModel, 'two')
  await store.saveModelSettings({ chatModel: 'three' })
  fs.writeFileSync(path.join(dir, 'ai-agent/settings.json'), '{corrupt')
  assert.equal(store.getModelSettings().chatModel, 'one')
})

test('atomic replacement failure leaves original file intact', async () => {
  let fail = false
  const fakeFs = { ...fs, promises: { ...fs.promises, rename: (from, to) => fail && to.endsWith('settings.json')
    ? Promise.reject(new Error('rename failed')) : fs.promises.rename(from, to) } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const store = load('src/main/storage.ts')
  await store.saveModelSettings({ chatModel: 'old' })
  fail = true
  await assert.rejects(store.saveModelSettings({ chatModel: 'new' }), /rename failed/)
  assert.equal(store.getModelSettings().chatModel, 'old')
})

test('backup export drains queued settings writes before taking the snapshot', async () => {
  const { load } = environment()
  const store = load('src/main/storage.ts')
  const write = store.saveModelSettings({ chatModel: 'queued-model' })
  const backup = await store.createBackupSnapshot()
  await write
  const settings = backup.files.find(file => file.relativePath === 'settings.json')
  assert.equal(JSON.parse(Buffer.from(settings.dataBase64, 'base64')).chatModel, 'queued-model')
})

test('restore drains previously admitted writes while blocking new writes', async () => {
  const { load } = environment()
  const store = load('src/main/storage.ts')
  const write = store.saveModelSettings({ chatModel: 'queued-original' })
  const restore = store.restoreBackupSnapshot(snapshot())
  await assert.rejects(store.saveModelSettings({ chatModel: 'late-write' }))
  const restored = await restore
  await write
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored.previousDataPath, 'settings.json'))).chatModel, 'queued-original')
  assert.equal(store.getModelSettings().chatModel, 'restored')
})

test('permission batch commits all changes together and rolls back on disk failure', () => {
  let fail = false
  const fakeFs = { ...fs, renameSync: (from, to) => {
    if (fail && to.endsWith('tool-policies.json')) throw new Error('disk failure')
    fs.renameSync(from, to)
  } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const policy = load('src/main/tools/policy.ts')
  const before = policy.toolPolicies.write_file.requiresConfirmation
  fail = true
  assert.throws(() => policy.updateToolPolicies({ write_file: !before, read_file: true }), /disk failure/)
  assert.equal(policy.toolPolicies.write_file.requiresConfirmation, before)
  assert.equal(policy.toolPolicies.read_file.requiresConfirmation, false)
  fail = false
  policy.updateToolPolicies({ write_file: !before, read_file: true })
  assert.equal(policy.toolPolicies.write_file.requiresConfirmation, !before)
  assert.equal(policy.toolPolicies.read_file.requiresConfirmation, true)
})

test('knowledge repository replacement failure retains the existing document index', () => {
  let fail = false
  const fakeFs = { ...fs, renameSync: (from, to) => {
    if (fail && to.endsWith('knowledge-bases.json')) throw new Error('disk failure')
    fs.renameSync(from, to)
  } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const repository = load('src/main/ragRepository.ts')
  const kb = repository.createKnowledgeBase({ name: 'original' })
  fail = true
  assert.throws(() => repository.updateKnowledgeBase(kb.id, { name: 'unsaved' }), /disk failure/)
  assert.equal(repository.getKnowledgeBase(kb.id).name, 'original')
})

const snapshot = (relativePath = 'settings.json', content = '{"chatModel":"restored"}') => ({
  version: 1, appName: 'centibot', createdAt: 1,
  files: [{ relativePath, dataBase64: Buffer.from(content).toString('base64') }],
})
test('invalid backup and staged write failure never remove existing data', async () => {
  let fail = false
  const fakeFs = { ...fs, writeFileSync: (file, ...args) => {
    if (fail && file.includes('ai-agent-restore-')) throw new Error('disk full')
    return fs.writeFileSync(file, ...args)
  } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const store = load('src/main/storage.ts')
  await store.saveModelSettings({ chatModel: 'original' })
  for (const invalid of [snapshot('../settings.json'), snapshot('/settings.json'), snapshot('C:/settings.json'), snapshot('settings.json', 'bad-json')]) {
    await assert.rejects(store.restoreBackupSnapshot(invalid))
    assert.equal(store.getModelSettings().chatModel, 'original')
  }
  fail = true
  await assert.rejects(store.restoreBackupSnapshot(snapshot()), /disk full/)
  assert.equal(store.getModelSettings().chatModel, 'original')
})

test('failed directory swap rolls back; successful restore retains previous data and prevents stale writes', async () => {
  let fail = true
  const fakeFs = { ...fs, renameSync: (from, to) => {
    if (fail && from.includes('ai-agent-restore-')) throw new Error('swap failed')
    return fs.renameSync(from, to)
  } }
  const { load } = environment({ fs: fakeFs, 'node:fs': fakeFs })
  const store = load('src/main/storage.ts')
  await store.saveModelSettings({ chatModel: 'original' })
  await assert.rejects(store.restoreBackupSnapshot(snapshot()), /swap failed/)
  assert.equal(store.getModelSettings().chatModel, 'original')
  fail = false
  const restored = await store.restoreBackupSnapshot(snapshot())
  assert.equal(store.getModelSettings().chatModel, 'restored')
  assert.equal(JSON.parse(fs.readFileSync(path.join(restored.previousDataPath, 'settings.json'))).chatModel, 'original')
  await assert.rejects(store.saveModelSettings({ chatModel: 'stale-runtime-value' }))
})

test('model IPC commits runtime only after persistence and serializes concurrent saves', async () => {
  const handlers = {}
  let runtime = { chatModel: 'old', agentModel: 'old' }
  let fail = true
  const { load } = environment({
    electron: { ipcMain: { handle: (name, fn) => { handlers[name] = fn } } },
    '../agent': { getModelSettingsSnapshot: () => ({ ...runtime }), applyModelSettings: next => { runtime = next } },
    '../storage': { saveModelSettings: async () => { if (fail) throw new Error('disk full') } },
    '../taskRunner': {}, '../openaiCompatible': {},
  })
  load('src/main/ipc/registerAppIpc.ts').registerAppIpcHandlers()
  await assert.rejects(handlers['settings:save-model-config']({}, { chatModel: 'new' }))
  assert.equal(runtime.chatModel, 'old')
  fail = false
  await Promise.all([handlers['models:set-chat']({}, 'chat-new'), handlers['models:set-agent']({}, 'agent-new')])
  assert.equal(runtime.chatModel, 'chat-new')
  assert.equal(runtime.agentModel, 'agent-new')
})

test('required confirmation fails closed; denial and abort cannot invoke tool', async () => {
  let calls = 0
  const { load } = environment({ '../tools': { allTools: [{ name: 'write_file', invoke: async () => { calls++; return 'ok' } }] } })
  const executor = load('src/main/runtime/ToolExecutor.ts')
  await assert.rejects(executor.executeTool('write_file', {}), /需要用户确认/)
  await executor.executeTool('write_file', {}, { confirm: async () => false })
  const controller = new AbortController()
  await assert.rejects(executor.executeTool('write_file', {}, { signal: controller.signal, confirm: async () => { controller.abort(); return true } }))
  assert.equal(calls, 0)
  await executor.executeTool('write_file', {}, { confirm: async () => true })
  assert.equal(calls, 1)
})

test('tool timeout aborts the underlying signal', async () => {
  let innerSignal
  const { load } = environment({
    '../tools/policy': { toolPolicies: { slow: { risk: ['read'], requiresConfirmation: false } } },
    '../tools': { allTools: [{ name: 'slow', invoke: (_, { signal }) => { innerSignal = signal; return new Promise(() => {}) } }] },
  })
  await assert.rejects(load('src/main/runtime/ToolExecutor.ts').executeTool('slow', {}, { timeoutMs: 10 }), /超时/)
  assert.ok(innerSignal.aborted)
})

test('every registered builtin tool has an explicit risk policy', () => {
  const { load } = environment({ '@langchain/core/tools': { tool: (handler, config) => ({ ...config, invoke: handler }) } })
  const { allTools } = load('src/main/tools/index.ts')
  const { toolPolicies } = load('src/main/tools/policy.ts')
  assert.ok(allTools.length > 20)
  for (const tool of allTools) {
    assert.ok(toolPolicies[tool.name], `Missing policy for ${tool.name}`)
    assert.ok(toolPolicies[tool.name].risk.length, `Missing risk for ${tool.name}`)
  }
  assert.ok(toolPolicies.open_url.risk.includes('network'))
})

function permissionEnvironment() {
  const calls = []
  const names = ['read_file', 'write_file', 'delete_file', 'fetch_url', 'open_url', 'unclassified']
  const toolPolicies = {
    read_file: { risk: ['read'], requiresConfirmation: false },
    write_file: { risk: ['write'], requiresConfirmation: false },
    delete_file: { risk: ['delete'], requiresConfirmation: true },
    fetch_url: { risk: ['network'], requiresConfirmation: false },
    open_url: { risk: ['network', 'system'], requiresConfirmation: false },
  }
  const env = environment({
    '../tools/policy': { toolPolicies },
    '../tools': { allTools: names.map(name => ({ name, invoke: async () => { calls.push(name); return 'ok' } })) },
  })
  return { ...env, calls, executor: env.load('src/main/runtime/ToolExecutor.ts'), permissions: env.load('src/main/runtime/toolPermissions.ts') }
}

test('chat agent binding fails closed for unsaved conversations and deleted agents', async () => {
  const { load } = environment()
  const store = load('src/main/storage.ts')
  const { getEffectiveAgentProfile } = load('src/main/runtime/agentAccess.ts')
  assert.throws(() => getEffectiveAgentProfile('new-chat'), /尚未保存/)
  const profile = { ...store.listAgentProfiles()[0], id: 'restricted', name: '限制助手', tools: { enabledToolNames: [], allowNetwork: false, allowWrite: false, allowDelete: false, requireConfirmationForRisky: true } }
  await store.saveAgentProfile(profile)
  await store.saveConversation({ id: 'new-chat', title: '新对话', agentProfileId: profile.id, createdAt: 1, updatedAt: 1 }, [])
  assert.equal(getEffectiveAgentProfile('new-chat').tools.allowNetwork, false)
  store.deleteAgentProfile(profile.id)
  assert.throws(() => getEffectiveAgentProfile('new-chat'), /已被删除/)
  assert.equal(getEffectiveAgentProfile(null), null)
})

test('category permissions and unknown policies block direct invocation before approval or I/O', async () => {
  const { executor, permissions, calls } = permissionEnvironment()
  let approvals = 0
  await permissions.withToolPermissions({ enabledToolNames: [], allowNetwork: false, allowWrite: false, allowDelete: false, requireConfirmationForRisky: false }, async () => {
    assert.equal(permissions.isToolAllowed('toString'), false)
    assert.equal(permissions.isToolAllowed('__proto__'), false)
    for (const name of ['fetch_url', 'open_url', 'write_file', 'delete_file', 'unclassified']) {
      await assert.rejects(executor.executeTool(name, {}, { confirm: async () => { approvals++; return true } }), /权限禁止/)
    }
    await executor.executeTool('read_file', {})
  })
  assert.deepEqual(calls, ['read_file'])
  assert.equal(approvals, 0)
})

test('model tool filtering and executor enforce the same allowlist and category intersection', async () => {
  const { executor, permissions, calls } = permissionEnvironment()
  await permissions.withToolPermissions({ enabledToolNames: ['read_file', 'fetch_url'], allowNetwork: false, allowWrite: true, allowDelete: true, requireConfirmationForRisky: false }, async () => {
    const tools = permissions.filterAllowedTools(['read_file', 'fetch_url', 'write_file', 'unclassified'], name => name)
    assert.deepEqual(Array.from(tools), ['read_file'])
    await executor.executeTool('read_file', {})
    for (const name of ['fetch_url', 'write_file']) await assert.rejects(executor.executeTool(name, {}), /权限禁止/)
  })
  assert.deepEqual(calls, ['read_file'])
})

test('concurrent runs isolate permissions and snapshot mutable profiles', async () => {
  const { executor, permissions, calls } = permissionEnvironment()
  const profile = { enabledToolNames: ['fetch_url'], allowNetwork: false, allowWrite: false, allowDelete: false, requireConfirmationForRisky: false }
  let resume
  const restricted = permissions.withToolPermissions(profile, async () => {
    await new Promise(resolve => { resume = resolve })
    await assert.rejects(executor.executeTool('fetch_url', {}), /权限禁止/)
    await assert.rejects(executor.executeTool('read_file', {}), /权限禁止/)
  })
  profile.allowNetwork = true
  profile.enabledToolNames.push('read_file')
  await permissions.withToolPermissions(undefined, async () => { await executor.executeTool('fetch_url', {}) })
  resume()
  await restricted
  assert.deepEqual(calls, ['fetch_url'])
})

test('agent confirmation cannot weaken a global requirement and risky actions fail closed', async () => {
  const { executor, permissions, calls } = permissionEnvironment()
  await permissions.withToolPermissions({ enabledToolNames: [], allowNetwork: true, allowWrite: true, allowDelete: true, requireConfirmationForRisky: true }, async () => {
    await assert.rejects(executor.executeTool('write_file', {}), /需要用户确认/)
    await executor.executeTool('write_file', {}, { confirm: async request => {
      assert.equal(request.policy.requiresConfirmation, true)
      return false
    } })
    await executor.executeTool('write_file', {}, { confirm: async () => true })
  })
  await permissions.withToolPermissions({ enabledToolNames: [], allowNetwork: true, allowWrite: true, allowDelete: true, requireConfirmationForRisky: false }, async () => {
    await assert.rejects(executor.executeTool('delete_file', {}), /需要用户确认/)
  })
  assert.deepEqual(calls, ['write_file'])
})

test('background tasks retain agent identity and block forced forbidden tool calls', async () => {
  let calls = 0, responses = 0
  const requests = []
  const { load } = environment({
    '../tools/policy': { toolPolicies: { fetch_url: { risk: ['network'], requiresConfirmation: false } } },
    '../tools': { allTools: [{ name: 'fetch_url', invoke: async () => { calls++; return 'network result' } }] },
    './openaiCompatible': {
      OPENAI_COMPATIBLE_TOOLS: [{ type: 'function', function: { name: 'fetch_url' } }],
      invokeOpenAICompatibleChat: async options => {
        requests.push(options); responses++
        return responses === 2
          ? { content: '', toolCalls: [{ id: 'forced', function: { name: 'fetch_url', arguments: '{"url":"https://mock.invalid"}' } }] }
          : { content: responses === 1 ? 'plan' : '无法联网，保留本地结果', toolCalls: [] }
      },
    },
  })
  const store = load('src/main/storage.ts')
  await store.saveAgentProfile({ ...store.listAgentProfiles()[0], id: 'offline', name: '离线助手', tools: { enabledToolNames: [], allowNetwork: false, allowWrite: false, allowDelete: false, requireConfirmationForRisky: true } })
  const runner = load('src/main/taskRunner.ts')
  const id = runner.createAndRunTask('普通任务', 'offline')
  await until(() => !runner.hasActiveTasks())
  assert.equal(runner.getTask(id).agentProfileId, 'offline')
  assert.equal(calls, 0)
  assert.equal(requests[1].tools.length, 0)
  assert.ok(runner.getTask(id).steps.some(step => step.content.includes('权限禁止')))
  assert.throws(() => runner.createAndRunTask('任务', 'missing'), /智能体不存在/)
  await runner.flushTaskWrites()
  const saved = JSON.parse(fs.readFileSync(path.join(store.getDataDir(), 'tasks.json')))
  assert.equal(saved.find(task => task.id === id).agentProfileId, 'offline')
  store.deleteAgentProfile('offline')
  const requestCount = requests.length
  assert.ok(runner.rerunTask(id))
  await until(() => !runner.hasActiveTasks())
  assert.equal(runner.getTask(id).status, 'failed')
  assert.equal(requests.length, requestCount, 'Deleted agents must not fall back to unrestricted execution')
  await runner.flushTaskWrites()
})

test('chat pre-calls and model-proposed calls cannot bypass disabled network permissions', async () => {
  let calls = 0, responses = 0
  const requests = [], results = []
  const tools = [{ name: 'fetch_url', invoke: async () => { calls++; return 'network result' } }]
  const { load } = environment({
    '@langchain/ollama': {}, '@langchain/core/messages': {},
    './tools': { allTools: tools }, '../tools': { allTools: tools },
    './tools/policy': { summarizeToolPolicies: () => '' },
    '../tools/policy': { toolPolicies: { fetch_url: { risk: ['network'], requiresConfirmation: false } } },
    './rag': {},
    './openaiCompatible': {
      OPENAI_COMPATIBLE_TOOLS: [{ type: 'function', function: { name: 'fetch_url' } }],
      buildCompatibleUserContent: text => text,
      invokeOpenAICompatibleChat: async options => {
        requests.push(options); responses++
        return responses === 1
          ? { content: '', toolCalls: [{ id: 'forced', function: { name: 'fetch_url', arguments: '{"url":"https://mock.invalid"}' } }] }
          : { content: '工具被禁止', toolCalls: [] }
      },
    },
  })
  const agent = load('src/main/agent.ts')
  agent.applyModelSettings({ agentProvider: 'openai-compatible' })
  await load('src/main/runtime/toolPermissions.ts').withToolPermissions({ enabledToolNames: [], allowNetwork: false, allowWrite: false, allowDelete: false, requireConfirmationForRisky: true }, async () => {
    await agent.chatWithAgent([], '查看 https://mock.invalid 的内容', () => {}, () => {}, (_, result) => results.push(result))
  })
  assert.equal(calls, 0)
  assert.ok(results.length >= 2, 'Both the pre-call and model-proposed call should pass through the executor')
  assert.ok(results.every(result => result.includes('权限禁止')))
  assert.ok(requests.every(request => request.tools.length === 0))
})

for (const scenario of ['same location', 'different location', 'failed pre-call']) {
  test(`weather pre-call reaches online model and handles ${scenario}`, async () => {
    const executions = [], calls = [], results = []
    let round = 0
    const preResult = scenario === 'failed pre-call' ? '天气查询失败: timeout' : '位置: 上海\n天气: 晴\n温度: 23°C'
    const { load } = environment({
      '@langchain/ollama': {}, '@langchain/core/messages': {},
      './tools': { allTools: [{ name: 'get_weather_current' }] },
      './tools/policy': { summarizeToolPolicies: () => '' },
      './rag': {},
      './runtime/ToolExecutor': { executeTool: async (name, args) => {
        executions.push({ name, args })
        return { result: executions.length === 1 ? preResult : `位置: ${args.location}\n天气: 晴` }
      } },
      './openaiCompatible': {
        OPENAI_COMPATIBLE_TOOLS: [], buildCompatibleUserContent: text => text,
        invokeOpenAICompatibleChat: async options => {
          if (round++ === 0) {
            const prior = options.messages.find(message => message.role === 'tool')
            assert.equal(prior?.content, preResult, 'Model must receive the pre-call result before deciding to query')
            assert.equal(options.messages.find(message => message.tool_calls)?.tool_calls[0].id, prior.tool_call_id)
            return { content: '', toolCalls: [{ id: 'weather_retry', type: 'function', function: {
              name: 'get_weather_current', arguments: JSON.stringify({ location: scenario === 'different location' ? '北京' : '上海', lang: 'zh' }),
            } }] }
          }
          assert.ok(options.messages.some(message => message.tool_call_id === 'weather_retry'))
          return { content: '天气已查询', toolCalls: [] }
        },
      },
    })
    const agent = load('src/main/agent.ts')
    agent.applyModelSettings({ agentProvider: 'openai-compatible' })
    await agent.chatWithAgent([], '上海天气', () => {}, name => calls.push(name), (_, result) => results.push(result))
    const expected = scenario === 'same location' ? 1 : 2
    assert.equal(executions.length, expected)
    assert.equal(calls.length, expected, 'Reused weather must not create a duplicate UI card')
    assert.equal(results.length, expected)
  })
}

test('cancelling a network tool aborts its real fetch signal and prevents fallback requests', async () => {
  let networkSignal, requests = 0
  let load
  load = createTsLoader({
    '../tools': { allTools: [{ name: 'network', invoke: async () => {
      const context = load('src/main/runtime/toolContext.ts')
      try { await context.fetchWithToolSignal('https://mock.invalid') } catch {}
      return context.fetchWithToolSignal('https://fallback.invalid')
    } }] },
    '../tools/policy': { toolPolicies: { network: { risk: ['network'], requiresConfirmation: false } } },
    './trace': { createTraceId: () => 'test', recordTrace: () => {} },
  }, { fetch: (_, options) => {
    requests++; networkSignal = options.signal
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
  } })
  const controller = new AbortController()
  const result = load('src/main/runtime/ToolExecutor.ts').executeTool('network', {}, { signal: controller.signal })
  await until(() => Boolean(networkSignal))
  controller.abort()
  await assert.rejects(result)
  await tick()
  assert.ok(networkSignal.aborted)
  assert.equal(requests, 1)
})

test('cancelling a task aborts model I/O and cannot be overwritten by a late response', async () => {
  let modelSignal, finish
  const { load } = environment({ './openaiCompatible': { OPENAI_COMPATIBLE_TOOLS: [], invokeOpenAICompatibleChat: options => {
    modelSignal = options.signal
    return new Promise(resolve => { finish = resolve })
  } } })
  const runner = load('src/main/taskRunner.ts')
  const id = runner.createAndRunTask('普通文字任务')
  await until(() => Boolean(finish))
  assert.ok(runner.cancelTask(id))
  assert.ok(modelSignal.aborted)
  finish({ content: 'late plan', toolCalls: [] })
  await until(() => !runner.hasActiveTasks())
  assert.equal(runner.getTask(id).status, 'cancelled')
  assert.equal(runner.getTask(id).steps.length, 0)
  await runner.flushTaskWrites()
})

test('task tools await approval, verify response owner, and execute only after approval', async () => {
  let calls = 0, responses = 0
  const { load, events, webContents } = environment({
    '../tools': { allTools: [{ name: 'write_file', invoke: async () => { calls++; return 'ok' } }] },
    './openaiCompatible': { OPENAI_COMPATIBLE_TOOLS: [], invokeOpenAICompatibleChat: async () => {
      responses++
      if (responses === 2) return { content: '', toolCalls: [{ id: 'call', function: { name: 'write_file', arguments: '{}' } }] }
      return { content: responses === 1 ? 'plan' : 'done', toolCalls: [] }
    } },
  })
  const runner = load('src/main/taskRunner.ts')
  const id = runner.createAndRunTask('执行测试任务')
  await until(() => events.some(e => e.channel === 'chat:tool-approval-request'))
  assert.equal(runner.getTask(id).status, 'waiting_for_approval')
  assert.equal(calls, 0)
  const approval = load('src/main/runtime/toolApprovals.ts')
  const request = events.find(e => e.channel === 'chat:tool-approval-request').data
  assert.equal(approval.resolveApproval(request.requestId, true, webContents.id + 100), false)
  assert.equal(approval.resolveApproval(request.requestId, true, webContents.id), true)
  await until(() => !runner.hasActiveTasks())
  assert.equal(calls, 1)
  assert.equal(runner.getTask(id).status, 'completed')
  await runner.flushTaskWrites()
})

test('cancelling a task waiting for approval removes the dialog without executing its tool', async () => {
  let calls = 0, responses = 0
  const { load, events } = environment({
    '../tools': { allTools: [{ name: 'write_file', invoke: async () => { calls++; return 'ok' } }] },
    './openaiCompatible': { OPENAI_COMPATIBLE_TOOLS: [], invokeOpenAICompatibleChat: async () => {
      responses++
      return responses === 1 ? { content: 'plan', toolCalls: [] }
        : { content: '', toolCalls: [{ id: 'call', function: { name: 'write_file', arguments: '{}' } }] }
    } },
  })
  const runner = load('src/main/taskRunner.ts')
  const id = runner.createAndRunTask('测试取消')
  await until(() => runner.getTask(id).status === 'waiting_for_approval')
  runner.cancelTask(id)
  await until(() => !runner.hasActiveTasks())
  assert.equal(calls, 0)
  assert.equal(runner.getTask(id).status, 'cancelled')
  assert.ok(events.some(e => e.channel === 'chat:tool-approval-cancelled'))
  await runner.flushTaskWrites()
})

test('task persistence errors are exposed and a successful retry clears the error', async () => {
  let fail = true
  const fakeFs = { ...fs, promises: { ...fs.promises, writeFile: (...args) => fail ? Promise.reject(new Error('disk full')) : fs.promises.writeFile(...args) } }
  const { load } = environment({
    fs: fakeFs, 'node:fs': fakeFs,
    './openaiCompatible': { OPENAI_COMPATIBLE_TOOLS: [], invokeOpenAICompatibleChat: () => new Promise(() => {}) },
  })
  const runner = load('src/main/taskRunner.ts')
  const id = runner.createAndRunTask('测试任务保存')
  await until(() => Boolean(runner.getTask(id).persistenceError))
  await assert.rejects(runner.flushTaskWrites(), /disk full/)
  fail = false
  await runner.retryTaskSave()
  assert.equal(runner.getTask(id).persistenceError, undefined)
  await runner.stopTasksForQuit()
  assert.equal(runner.getTask(id).status, 'cancelled')
})

test('concurrent approval dialogs are serialized and cancellation releases the queue', async () => {
  const { load, events, webContents } = environment()
  const approval = load('src/main/runtime/toolApprovals.ts')
  const controller = new AbortController()
  const first = approval.requestApproval({ toolName: 'one', args: {} }, { webContents, conversationId: 'one', signal: controller.signal })
  const second = approval.requestApproval({ toolName: 'two', args: {} }, { webContents, conversationId: 'two' })
  await tick()
  assert.equal(events.filter(e => e.channel === 'chat:tool-approval-request').length, 1)
  controller.abort()
  await assert.rejects(first)
  await tick()
  const requests = events.filter(e => e.channel === 'chat:tool-approval-request')
  assert.equal(requests.length, 2)
  assert.ok(events.some(e => e.channel === 'chat:tool-approval-cancelled'))
  approval.resolveApproval(requests[1].data.requestId, false, webContents.id)
  assert.equal(await second, false)
})

test('settings load successes are applied independently and stale results are ignored', async () => {
  const load = createTsLoader()
  const { loadSettingsResources } = load('src/renderer/src/settingsLoader.ts')
  const applied = [], failures = []
  const done = loadSettingsResources([
    { id: 'ok', label: '模型', load: async () => 42, apply: value => applied.push(value) },
    { id: 'slow', label: '日志', load: () => new Promise(() => {}), apply: () => assert.fail() },
    { id: 'stale', label: '旧请求', load: async () => 99, apply: () => assert.fail() },
  ], { timeoutMs: 15, start: () => {}, isCurrent: r => r.id !== 'stale', finish: (_, error) => { if (error) failures.push(error) } })
  await tick()
  assert.deepEqual(applied, [42])
  await done
  assert.equal(failures.length, 1)
  assert.match(failures[0], /加载超时/)
})
