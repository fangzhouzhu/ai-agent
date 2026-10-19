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
  const { load } = environment({ '../tools': { allTools: [{ name: 'slow', invoke: (_, { signal }) => { innerSignal = signal; return new Promise(() => {}) } }] } })
  await assert.rejects(load('src/main/runtime/ToolExecutor.ts').executeTool('slow', {}, { timeoutMs: 10 }), /超时/)
  assert.ok(innerSignal.aborted)
})

test('cancelling a network tool aborts its real fetch signal and prevents fallback requests', async () => {
  let networkSignal, requests = 0
  let load
  load = createTsLoader({
    '../tools': { allTools: [{ name: 'network', invoke: async () => {
      const context = load('src/main/runtime/toolContext.ts')
      try { await context.fetchWithToolSignal('https://mock.invalid') } catch {}
      return context.fetchWithToolSignal('https://fallback.invalid')
    } }] },
    '../tools/policy': { toolPolicies: {} },
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
