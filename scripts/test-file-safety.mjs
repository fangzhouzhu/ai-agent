import assert from 'node:assert/strict'
import { test, after } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import JSZip from 'jszip'
import { pathToFileURL } from 'node:url'
import { createTsLoader } from './lib/load-typescript.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'centibot-file-check-'))
let sequence = 0
after(() => {
  const absolute = path.resolve(root)
  assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep))
  fs.rmSync(absolute, { recursive: true, force: true })
})

function environment(extra = {}) {
  const dir = path.join(root, String(sequence++))
  const workspace = path.join(dir, 'workspace')
  const outside = path.join(dir, 'outside')
  fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(outside)
  const handlers = {}
  const mocks = {
    electron: { app: { getPath: () => dir, getAppPath: () => dir, isPackaged: true }, ipcMain: { handle: (name, fn) => { handlers[name] = fn } }, shell: { trashItem: async target => fs.renameSync(target, path.join(outside, path.basename(target))) } },
    '@langchain/core/tools': { tool: (handler, config) => ({ ...config, invoke: args => handler(config.schema.parse(args)) }) },
    './trace': { createTraceId: () => 'test', recordTrace: () => {}, previewTraceValue: value => String(value) },
    ...extra,
  }
  const load = createTsLoader(mocks)
  const access = load('src/main/runtime/workspaces.ts')
  const files = load('src/main/runtime/fileOperations.ts')
  const executor = load('src/main/runtime/ToolExecutor.ts')
  const authorize = (rights = { allowWrite: true, allowDelete: true }) => {
    const grants = access.addWorkspace(workspace)
    const grant = grants.find(item => !item.builtin)
    access.updateWorkspace(grant.id, rights)
    return grant.id
  }
  return { dir, workspace, outside, load, access, files, executor, authorize, handlers }
}

const approve = { confirm: async () => true }

test('default access only permits artifacts; native grants start read-only and cannot alter root via rights', async () => {
  const env = environment()
  const { workspace, outside, executor, access } = env
  const file = path.join(workspace, 'note.txt')
  fs.writeFileSync(file, 'original')
  await assert.rejects(executor.executeTool('read_file', { filePath: file }), /未授权读取/)
  const grant = access.addWorkspace(workspace).find(item => !item.builtin)
  assert.match((await executor.executeTool('read_file', { filePath: file })).result, /original/)
  await assert.rejects(executor.executeTool('write_file', { filePath: file, content: 'new' }, approve), /未授权写入/)
  access.updateWorkspace(grant.id, { allowWrite: true, allowDelete: false, root: outside, id: 'artifacts' })
  assert.equal(access.listWorkspaces().find(item => item.id === grant.id).root, access.canonicalPath(workspace))
  await executor.executeTool('write_file', { filePath: file, content: 'new' }, approve)
  await assert.rejects(executor.executeTool('delete_file', { filePath: file }, approve), /未授权删除/)
  const artifact = path.join(access.artifactRoot(), 'report.txt')
  await executor.executeTool('write_file', { filePath: artifact, content: 'report' }, approve)
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'report')
  await assert.rejects(executor.executeTool('read_file', { filePath: path.join(env.dir, 'ai-agent', 'workspaces.json') }), /应用配置/)
  assert.throws(() => access.addWorkspace(path.parse(workspace).root), /整个磁盘|系统路径/)
})

test('prefix siblings, traversal, directory junctions and hard-linked mutations are denied', async () => {
  const { workspace, outside, executor, authorize, access } = environment()
  authorize()
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.mkdirSync(`${workspace}-other`)
  for (const target of [path.join(`${workspace}-other`, 'x'), path.join(workspace, '..', 'outside', 'secret.txt')]) {
    await assert.rejects(executor.executeTool('read_file', { filePath: target }), /未授权/)
  }
  fs.symlinkSync(outside, path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(executor.executeTool('read_file', { filePath: path.join(workspace, 'linked', 'secret.txt') }), /未授权|链接|联接/)
  await assert.rejects(executor.executeTool('search_file_content', { dirPath: workspace, keyword: 'secret' }), /未授权|链接|联接/)
  const linked = path.join(workspace, 'hard.txt')
  fs.linkSync(path.join(outside, 'secret.txt'), linked)
  await assert.rejects(executor.executeTool('write_file', { filePath: linked, content: 'changed' }, approve), /硬链接/)
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret')
  if (process.platform === 'win32') {
    assert.throws(() => access.canonicalPath(path.join(workspace, 'file.txt:secret')), /备用数据流/)
    assert.throws(() => access.canonicalPath(path.join(workspace, 'CON.txt')), /设备路径/)
  }
})

test('replacing a selected workspace ancestor with a junction cannot widen its authorization', async () => {
  const { workspace, outside, executor, access } = environment()
  const parent = path.join(workspace, 'parent')
  const selected = path.join(parent, 'selected')
  fs.mkdirSync(selected, { recursive: true })
  access.addWorkspace(selected)
  fs.mkdirSync(path.join(outside, 'selected'))
  fs.writeFileSync(path.join(outside, 'selected', 'secret.txt'), 'private')
  fs.renameSync(parent, `${parent}-old`)
  fs.symlinkSync(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(executor.executeTool('read_file', { filePath: path.join(selected, 'secret.txt') }), /未授权|链接|联接/)
})

test('corrupt authorization data never resurrects grants from an older backup', async () => {
  const { dir, workspace, executor, access, authorize } = environment()
  const id = authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'private')
  access.updateWorkspace(id, null)
  fs.writeFileSync(path.join(dir, 'ai-agent', 'workspaces.json'), '{corrupt')
  await assert.rejects(executor.executeTool('read_file', { filePath: target }), /停止文件访问/)
})

test('denial, cancellation, edited confirmation arguments and changed files preserve approval boundaries', async () => {
  const { workspace, outside, executor, authorize, files } = environment()
  authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'before')
  let preview = ''
  await executor.executeTool('write_file', { filePath: target, content: 'after' }, { confirm: async request => { preview = request.preview; return false } })
  assert.match(preview, /修改前：[\s\S]*before[\s\S]*修改后：[\s\S]*after/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'before')
  assert.equal(files.listFileRevisions().length, 0)
  const controller = new AbortController()
  await assert.rejects(executor.executeTool('write_file', { filePath: target, content: 'after' }, { signal: controller.signal, confirm: async () => { controller.abort(); return true } }))
  assert.equal(files.listFileRevisions().length, 0)
  await assert.rejects(executor.executeTool('write_file', { filePath: target, content: 'after' }, { confirm: async () => { fs.writeFileSync(target, 'external edit'); return true } }), /确认期间发生变化/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'external edit')
  await executor.executeTool('write_file', { filePath: target, content: 'approved' }, { confirm: async request => {
    request.args.filePath = path.join(outside, 'escape.txt'); request.args.content = 'tampered'
    return true
  } })
  assert.equal(fs.readFileSync(target, 'utf8'), 'approved')
  assert.equal(fs.existsSync(path.join(outside, 'escape.txt')), false)
})

test('revocation during approval prevents mutation and recovery requires a current write grant', async () => {
  const { workspace, executor, authorize, access, files } = environment()
  let id = authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'original')
  await assert.rejects(executor.executeTool('write_file', { filePath: target, content: 'new' }, { confirm: async () => { access.updateWorkspace(id, null); return true } }), /未授权/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'original')
  id = authorize()
  await executor.executeTool('write_file', { filePath: target, content: 'new' }, approve)
  const revision = files.listFileRevisions()[0]
  access.updateWorkspace(id, { allowWrite: false, allowDelete: false })
  await assert.rejects(files.restoreFileRevision(revision.id), /未授权写入/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'new')
})

test('overwrites retain verifiable backups; restore preserves the current version and rejects corrupt backups', async () => {
  const { dir, workspace, executor, authorize, files } = environment()
  authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'v1')
  await executor.executeTool('write_file', { filePath: target, content: 'v2' }, approve)
  const revision = files.listFileRevisions()[0]
  await files.restoreFileRevision(revision.id)
  assert.equal(fs.readFileSync(target, 'utf8'), 'v1')
  const undoRestore = files.listFileRevisions().find(item => item.toolName === 'restore_revision')
  assert.ok(undoRestore)
  await files.restoreFileRevision(undoRestore.id)
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2')
  fs.writeFileSync(path.join(dir, 'ai-agent', 'file-revisions', `${revision.id}.data`), 'corrupt')
  await assert.rejects(files.restoreFileRevision(revision.id), /校验失败/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'v2')
})

test('backup failure cannot truncate the original file', async () => {
  const fakeFs = { ...fs, writeFileSync: (target, ...args) => {
    if (String(target).endsWith('.data')) throw new Error('backup disk full')
    return fs.writeFileSync(target, ...args)
  } }
  const { workspace, executor, authorize } = environment({ 'node:fs': fakeFs })
  authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'preserved')
  await assert.rejects(executor.executeTool('write_file', { filePath: target, content: 'lost' }, approve), /backup disk full/)
  assert.equal(fs.readFileSync(target, 'utf8'), 'preserved')
})

test('existing files require approval even with automatic execution enabled', async () => {
  const { workspace, executor, authorize, load } = environment()
  authorize()
  const target = path.join(workspace, 'note.txt')
  await load('src/main/runtime/toolPermissions.ts').withToolPermissions({ enabledToolNames: [], allowNetwork: true, allowWrite: true, allowDelete: true, requireConfirmationForRisky: false }, async () => {
    await executor.executeTool('write_file', { filePath: target, content: 'new' })
    await assert.rejects(executor.executeTool('write_file', { filePath: target, content: 'overwritten' }), /需要用户确认/)
  })
  assert.equal(fs.readFileSync(target, 'utf8'), 'new')
})

test('deletion preserves a recovery copy and restores a now-missing file', async () => {
  const { workspace, executor, authorize, files } = environment()
  authorize()
  const target = path.join(workspace, 'note.txt')
  fs.writeFileSync(target, 'recover me')
  await executor.executeTool('delete_file', { filePath: target }, approve)
  assert.equal(fs.existsSync(target), false)
  const revision = files.listFileRevisions()[0]
  await files.restoreFileRevision(revision.id)
  assert.equal(fs.readFileSync(target, 'utf8'), 'recover me')
})

test('a cancelled file operation waiting on the mutation queue cannot write later', async () => {
  const { workspace, executor, authorize, files } = environment()
  authorize()
  let release
  const held = files.withFileOperationLock(() => new Promise(resolve => { release = resolve }))
  await new Promise(resolve => setImmediate(resolve))
  const target = path.join(workspace, 'cancelled.txt')
  const controller = new AbortController()
  const operation = executor.executeTool('write_file', { filePath: target, content: 'no' }, { ...approve, signal: controller.signal })
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(operation)
  release(); await held
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fs.existsSync(target), false)
  assert.equal(files.listFileRevisions().length, 0)
})

test('directory operations reject overlaps, root moves and existing targets without deleting content', async () => {
  const { workspace, executor, authorize } = environment()
  authorize()
  const source = path.join(workspace, 'source'), destination = path.join(workspace, 'destination')
  fs.mkdirSync(source); fs.mkdirSync(destination)
  fs.writeFileSync(path.join(source, 's.txt'), 'source'); fs.writeFileSync(path.join(destination, 'd.txt'), 'keep')
  for (const name of ['copy_directory', 'move_directory']) {
    await assert.rejects(executor.executeTool(name, { sourcePath: source, destinationPath: destination, overwrite: true }, approve), /目标目录已存在/)
    await assert.rejects(executor.executeTool(name, { sourcePath: source, destinationPath: path.join(source, 'child') }, approve), /互相包含/)
  }
  await assert.rejects(executor.executeTool('move_directory', { sourcePath: workspace, destinationPath: path.join(path.dirname(workspace), 'moved') }, approve), /未授权|根目录/)
  await executor.executeTool('copy_directory', { sourcePath: source, destinationPath: path.join(workspace, 'copy') }, approve)
  assert.equal(fs.readFileSync(path.join(workspace, 'copy', 's.txt'), 'utf8'), 'source')
  await executor.executeTool('move_directory', { sourcePath: source, destinationPath: path.join(workspace, 'moved') }, approve)
  assert.equal(fs.existsSync(source), false)
  assert.equal(fs.readFileSync(path.join(destination, 'd.txt'), 'utf8'), 'keep')
})

test('archives round-trip through authorized paths and reject traversal, link entries and existing destinations', async () => {
  const { workspace, executor, authorize } = environment()
  authorize()
  const source = path.join(workspace, 'source'), zipPath = path.join(workspace, 'good.zip')
  fs.mkdirSync(source); fs.writeFileSync(path.join(source, '文件.txt'), '资料')
  await executor.executeTool('make_zip', { sourcePath: source, zipPath }, approve)
  const extracted = path.join(workspace, 'extracted')
  await executor.executeTool('extract_zip', { zipPath, destinationPath: extracted }, approve)
  assert.equal(fs.readFileSync(path.join(extracted, 'source', '文件.txt'), 'utf8'), '资料')
  await assert.rejects(executor.executeTool('extract_zip', { zipPath, destinationPath: extracted, overwrite: true }, approve), /目标目录已存在/)
  const archives = [new JSZip().file('../escape.txt', 'bad'), new JSZip().file('linked', 'outside', { unixPermissions: 0o120777 })]
  for (let i = 0; i < archives.length; i++) {
    const malicious = path.join(workspace, `bad-${i}.zip`), target = path.join(workspace, `bad-${i}`)
    fs.writeFileSync(malicious, await archives[i].generateAsync({ type: 'nodebuffer', platform: 'UNIX' }))
    const result = await executor.executeTool('extract_zip', { zipPath: malicious, destinationPath: target }, approve)
    assert.match(result.result, /失败/)
    assert.equal(fs.existsSync(target), false)
  }
  assert.equal(fs.existsSync(path.join(workspace, 'escape.txt')), false)
})

test('oversized decompression fails before publishing a destination', async () => {
  const { workspace, executor, authorize } = environment()
  authorize()
  const source = path.join(workspace, 'large.zip'), destination = path.join(workspace, 'large')
  fs.writeFileSync(source, await new JSZip().file('large.txt', Buffer.alloc(50 * 1024 * 1024 + 1)).generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const result = await executor.executeTool('extract_zip', { zipPath: source, destinationPath: destination }, approve)
  assert.match(result.result, /超过 50 MiB/)
  assert.equal(fs.existsSync(destination), false)
})

test('workspace IPC uses native folder selection and restore confirmation, rejecting other frames and pages', async () => {
  let selected = '', response = 0
  const env = environment()
  const electron = { app: { getPath: () => env.dir, getAppPath: () => env.dir, isPackaged: true }, ipcMain: { handle: (name, fn) => { env.handlers[name] = fn } }, dialog: { showOpenDialog: async () => ({ canceled: !selected, filePaths: [selected] }), showMessageBox: async () => ({ response }) } }
  const load = createTsLoader({ electron })
  load('src/main/ipc/registerWorkspaceIpc.ts').registerWorkspaceIpcHandlers()
  const frame = { url: pathToFileURL(path.join(env.dir, 'out/renderer/index.html')).href }
  const event = { sender: { mainFrame: frame }, senderFrame: frame }
  assert.throws(() => env.handlers['workspaces:list']({ ...event, senderFrame: { url: frame.url } }), /主窗口/)
  const other = { url: pathToFileURL(path.join(env.dir, 'other.html')).href }
  assert.throws(() => env.handlers['workspaces:list']({ sender: { mainFrame: other }, senderFrame: other }), /来源无效/)
  selected = env.workspace
  const grants = await env.handlers['workspaces:pick'](event)
  assert.ok(grants.some(grant => grant.root === env.access.canonicalPath(env.workspace) && !grant.allowWrite))
  const grant = grants.find(item => !item.builtin)
  env.handlers['workspaces:update'](event, grant.id, { allowWrite: true, allowDelete: false })
  const target = path.join(env.workspace, 'note.txt')
  fs.writeFileSync(target, 'before')
  await env.executor.executeTool('write_file', { filePath: target, content: 'after' }, approve)
  const revision = env.files.listFileRevisions()[0]
  assert.equal(await env.handlers['workspaces:restore-file'](event, revision.id), false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'after')
  response = 1
  assert.equal(await env.handlers['workspaces:restore-file'](event, revision.id), true)
  assert.equal(fs.readFileSync(target, 'utf8'), 'before')
})
