import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/renderer/src/modelSettings.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
const { prepareModelSettings, validateOnlineConnection } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const route = { provider: 'openai-compatible', model: ' deepseek-chat ' }
const config = {
  chat: route, agent: { provider: 'ollama', model: 'old-local' }, rag: { ...route, model: 'old-online' },
  online: { name: '', provider: 'DeepSeek', baseUrl: ' https://api.deepseek.com/v1/ ', apiKey: ' test-key ' },
  onlineProfiles: [], activeOnlineProfileId: null,
}

const saved = prepareModelSettings(config, 'new-profile', ['deepseek-chat', 'deepseek-reasoner'])
assert.equal(saved.activeOnlineProfileId, 'new-profile')
assert.equal(saved.onlineProfiles.length, 1)
assert.equal(saved.online.name, 'DeepSeek')
assert.equal(saved.online.baseUrl, 'https://api.deepseek.com/v1')
assert.equal(saved.online.apiKey, 'test-key')
assert.deepEqual(saved.agent, saved.chat)
assert.deepEqual(saved.rag, saved.chat)
assert.equal(saved.onlineProfiles[0].chatModel, 'deepseek-chat')
assert.equal(config.onlineProfiles.length, 0, 'Preparing a save must not mutate the draft')

const edited = prepareModelSettings({ ...saved, chat: { ...route, model: 'deepseek-reasoner' } }, 'unused', [])
assert.equal(edited.onlineProfiles.length, 1, 'Editing must update the existing profile')
assert.equal(edited.onlineProfiles[0].id, 'new-profile')
assert.equal(edited.onlineProfiles[0].createdAt, saved.onlineProfiles[0].createdAt)
assert.equal(edited.onlineProfiles[0].ragModel, 'deepseek-reasoner')
assert.deepEqual(edited.onlineProfiles[0].models, ['deepseek-reasoner', 'deepseek-chat'])

const changedConnection = prepareModelSettings({ ...saved, online: { ...saved.online, apiKey: 'another-key' } }, 'unused', [])
assert.deepEqual(changedConnection.onlineProfiles[0].models, ['deepseek-chat'], 'Changed credentials must not reuse a stale model list')
assert.throws(() => prepareModelSettings({ ...config, chat: { ...route, model: ' ' } }, 'id', []))
assert.throws(() => prepareModelSettings({ ...config, onlineProfiles: saved.onlineProfiles }, 'id', []), /配置名称已存在/)
for (const baseUrl of ['', 'not-a-url', 'file:///tmp', 'https://user:password@example.com/v1', 'https://example.com/v1?key=secret']) {
  assert.ok(validateOnlineConnection({ ...config.online, baseUrl }), `Must reject ${baseUrl}`)
}
assert.ok(validateOnlineConnection({ ...config.online, apiKey: ' ' }))
assert.equal(validateOnlineConnection({ ...config.online, baseUrl: 'http://localhost:1234/v1' }), null)
const local = prepareModelSettings({ ...config, chat: { provider: 'ollama', model: ' qwen2.5:3b ' }, online: { ...config.online, apiKey: '' } }, 'unused', [])
assert.equal(local.chat.model, 'qwen2.5:3b')
assert.deepEqual(local.agent, local.chat)
assert.equal(local.onlineProfiles.length, 0, 'Local save must not create an online profile')
console.log('Model settings regression checks passed.')
