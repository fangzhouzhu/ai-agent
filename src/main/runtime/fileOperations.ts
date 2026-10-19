import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import { assertWorkspaceAccess, assertNotWorkspaceRoot, containsPath, type FileAccess } from './workspaces';
import { isRestorePending } from '../storage';
import { atomicWriteJsonSync } from './persistence';

type Access = { path: string; access: FileAccess; tree?: boolean };
export type FileOperationPlan = { args: Record<string, unknown>; accesses: Access[]; states: string[]; preview: string; mutates: boolean };
export type FileRevision = { id: string; originalPath: string; createdAt: number; toolName: string; size: number; hash: string };
const backupRoot = () => path.join(app.getPath('userData'), 'ai-agent', 'file-revisions');
const MAX_BYTES = 50 * 1024 * 1024;
let queue: Promise<unknown> = Promise.resolve();

// Keep the lock until the underlying operation settles, even if its caller
// has timed out. New operations check cancellation after acquiring the lock.
export function withFileOperationLock<T>(work: () => Promise<T>): Promise<T> {
  const operation = queue.catch(() => undefined).then(work);
  queue = operation;
  return operation;
}

function pathState(item: Access, budget = { count: 0, bytes: 0 }): string {
  assertWorkspaceAccess(item.path, item.access);
  const visit = (target: string): string => {
    assertWorkspaceAccess(target, item.access);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
    if (++budget.count > 2000) throw new Error('单次操作超过 2000 个文件或目录，请缩小范围。');
    if (stat.isDirectory()) {
      if (!item.tree) return `dir:${stat.dev}:${stat.ino}:${stat.mtimeMs}`;
      return createHash('sha256').update(fs.readdirSync(target).sort().map(name => `${name}:${visit(path.join(target, name))}`).join('\n')).digest('hex');
    }
    if (!stat.isFile()) throw new Error('只允许操作普通文件和目录。');
    budget.bytes += stat.size;
    if (budget.bytes > MAX_BYTES) throw new Error('单次文件操作超过 50 MiB，请缩小范围。');
    return `${stat.dev}:${stat.ino}:${createHash('sha256').update(fs.readFileSync(target)).digest('hex')}`;
  };
  return visit(item.path);
}

export function prepareFileOperation(name: string, input: unknown): FileOperationPlan | null {
  const definitions: Record<string, Array<[string, FileAccess, boolean?]>> = {
    read_file: [['filePath', 'read']], read_json: [['filePath', 'read']], read_csv: [['filePath', 'read']],
    file_exists: [['targetPath', 'read']], path_stat: [['targetPath', 'read']],
    list_directory: [['dirPath', 'read']], search_files: [['dirPath', 'read', true]], search_file_content: [['dirPath', 'read', true]],
    write_file: [['filePath', 'write']], append_file: [['filePath', 'write']], write_json: [['filePath', 'write']],
    insert_into_file: [['filePath', 'write']], replace_in_file: [['filePath', 'write']], replace_regex_in_file: [['filePath', 'write']],
    create_directory: [['dirPath', 'write']], delete_file: [['filePath', 'delete']],
    copy_file: [['sourcePath', 'read'], ['destinationPath', 'write']],
    move_file: [['sourcePath', 'write'], ['destinationPath', 'write']],
    copy_directory: [['sourcePath', 'read', true], ['destinationPath', 'write', true]],
    move_directory: [['sourcePath', 'write', true], ['destinationPath', 'write', true]],
    make_zip: [['sourcePath', 'read', true], ['zipPath', 'write']],
    extract_zip: [['zipPath', 'read'], ['destinationPath', 'write', true]],
    open_path: [['targetPath', 'read']], reveal_in_folder: [['targetPath', 'read']],
    generate_pdf: [['filePath', 'write']], generate_pptx: [['filePath', 'write']],
  };
  if (!Object.prototype.hasOwnProperty.call(definitions, name)) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('文件工具参数必须是对象。');
  const args = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
  if (name === 'generate_pdf' || name === 'generate_pptx') {
    const suffix = name === 'generate_pdf' ? '.pdf' : '.pptx';
    if (typeof args.filePath === 'string' && !args.filePath.endsWith(suffix)) args.filePath += suffix;
  }
  const accesses = definitions[name].map(([key, access, tree]) => {
    if (typeof args[key] !== 'string') throw new Error(`缺少有效文件路径：${key}`);
    const normalized = assertWorkspaceAccess(args[key] as string, access);
    args[key] = normalized;
    return { path: normalized, access, tree };
  });
  if (['copy_directory', 'move_directory', 'make_zip'].includes(name)) {
    if (containsPath(accesses[0].path, accesses[1].path) || containsPath(accesses[1].path, accesses[0].path)) throw new Error('源路径与目标路径不能相同或互相包含。');
  }
  if (['copy_file', 'move_file'].includes(name) && accesses[0].path === accesses[1].path) throw new Error('源文件和目标文件不能相同。');
  if (['copy_directory', 'move_directory', 'extract_zip'].includes(name) && fs.existsSync(accesses[1].path)) throw new Error('目标目录已存在。为保护原内容，请选择新的目录；不支持删除原目录后覆盖。');
  if (name === 'move_file' && fs.existsSync(accesses[1].path)) throw new Error('目标文件已存在，请选择新的文件名。');
  if (name === 'move_directory') assertNotWorkspaceRoot(accesses[0].path);
  const budget = { count: 0, bytes: 0 };
  const states = accesses.map(item => pathState(item, budget));
  let preview = accesses.map(item => `${item.access === 'read' ? '读取' : item.access === 'delete' ? '删除（移入回收站）' : fs.existsSync(item.path) ? '修改（执行前备份文件）' : '创建'}：${item.path}`).join('\n');
  if (['write_file', 'append_file', 'write_json', 'replace_in_file', 'replace_regex_in_file', 'insert_into_file'].includes(name)) {
    const target = accesses[0].path;
    if (!fs.existsSync(target) || (fs.statSync(target).isFile() && fs.statSync(target).size <= 100_000)) {
      const before = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      let after = before;
      if (name === 'write_file') after = String(args.content);
      if (name === 'append_file') after += String(args.content);
      if (name === 'write_json') after = JSON.stringify(args.data, null, args.pretty === false ? 0 : 2);
      if (name === 'replace_in_file') after = args.replaceAll ? before.split(String(args.searchText)).join(String(args.replaceText)) : before.replace(String(args.searchText), String(args.replaceText));
      if (name === 'replace_regex_in_file') after = before.replace(new RegExp(String(args.pattern), String(args.flags || '')), String(args.replaceText));
      if (name === 'insert_into_file') {
        const lines = before.split(/\r?\n/);
        const index = Math.max(1, Math.min(Number(args.lineNumber), lines.length + 1)) - 1;
        lines.splice(args.position === 'before' ? index : index + 1, 0, String(args.text));
        after = lines.join('\n');
      }
      const excerpt = (value: string) => value.length > 1600 ? value.slice(0, 1600) + '\n…（预览已截断）' : value || '（空内容）';
      preview += `\n\n修改前：\n${excerpt(before)}\n\n修改后：\n${excerpt(after)}`;
    } else preview += '\n文件较大，不展示完整内容；执行前会保留原文件备份。';
  }
  return { args, accesses, states, preview, mutates: accesses.some(item => item.access !== 'read') };
}

export function validateFileOperation(plan: FileOperationPlan): void {
  if (isRestorePending()) throw new Error('备份已恢复，请重启后执行文件操作。');
  const budget = { count: 0, bytes: 0 };
  for (let i = 0; i < plan.accesses.length; i++) {
    if (pathState(plan.accesses[i], budget) !== plan.states[i]) throw new Error('文件或目录在确认期间发生变化，已停止执行，请重新发起操作。');
  }
}

function backupFile(target: string, toolName: string): FileRevision | null {
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  if (fs.statSync(target).size > MAX_BYTES) throw new Error('文件超过 50 MiB，无法安全备份。');
  const data = fs.readFileSync(target);
  const root = backupRoot();
  fs.mkdirSync(root, { recursive: true });
  const files = fs.readdirSync(root);
  if (files.length > 2000 || files.filter(name => name.endsWith('.data')).reduce((total, name) => total + fs.statSync(path.join(root, name)).size, data.length) > 512 * 1024 * 1024) throw new Error('文件恢复备份已达到 512 MiB 或数量上限，请先通过应用数据目录归档备份。');
  const revision: FileRevision = { id: randomUUID(), originalPath: target, createdAt: Date.now(), toolName, size: data.length, hash: createHash('sha256').update(data).digest('hex') };
  fs.writeFileSync(path.join(root, `${revision.id}.data`), data, { flag: 'wx' });
  atomicWriteJsonSync(path.join(root, `${revision.id}.json`), JSON.stringify(revision));
  return revision;
}

export function backupFileOperation(plan: FileOperationPlan, toolName: string): FileRevision[] {
  return plan.accesses.filter(item => item.access !== 'read').map(item => backupFile(item.path, toolName)).filter((item): item is FileRevision => item !== null);
}

export function listFileRevisions(): FileRevision[] {
  if (!fs.existsSync(backupRoot())) return [];
  return fs.readdirSync(backupRoot()).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => {
    const revision = JSON.parse(fs.readFileSync(path.join(backupRoot(), name), 'utf8')) as FileRevision;
    if (`${revision.id}.json` !== name || typeof revision.originalPath !== 'string' || !path.isAbsolute(revision.originalPath)) throw new Error('恢复记录无效。');
    return revision;
  }).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}

export function restoreFileRevision(id: string): Promise<void> {
  return withFileOperationLock(async () => {
    if (isRestorePending()) throw new Error('备份已恢复，请重启后恢复文件。');
    const revision = listFileRevisions().find(item => item.id === id);
    if (!revision) throw new Error('恢复记录不存在。');
    const target = assertWorkspaceAccess(revision.originalPath, 'write');
    if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error('目标已变为目录，拒绝覆盖。');
    const data = fs.readFileSync(path.join(backupRoot(), `${revision.id}.data`));
    if (createHash('sha256').update(data).digest('hex') !== revision.hash) throw new Error('恢复备份校验失败，原文件未修改。');
    backupFile(target, 'restore_revision');
    const temporary = path.join(path.dirname(target), `.centibot-restore-${randomUUID()}.tmp`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.writeFileSync(temporary, data, { flag: 'wx' });
      assertWorkspaceAccess(target, 'write');
      fs.renameSync(temporary, target);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  });
}
