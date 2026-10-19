import { app } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWriteJsonSync } from './persistence';
import { isRestorePending } from '../storage';

export type WorkspaceGrant = { id: string; root: string; allowWrite: boolean; allowDelete: boolean; builtin?: boolean };
export type FileAccess = 'read' | 'write' | 'delete';

export function artifactRoot(): string {
  return path.join(app.getPath('userData'), 'ai-agent', 'artifacts');
}
const storePath = () => path.join(app.getPath('userData'), 'ai-agent', 'workspaces.json');

export function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

export function canonicalPath(input: string): string {
  if (typeof input !== 'string' || !input.trim() || /[\x00-\x1f]/.test(input)) throw new Error('文件路径无效。');
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(input) || /:/.test(input.replace(/^[a-z]:/i, '')) ||
    input.split(/[\\/]/).some(part => /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) {
    throw new Error('不允许设备路径、备用数据流或不明确的 Windows 文件名。');
  }
  let current = path.resolve(input);
  const missing: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A dangling link must not be treated as a new file.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('不允许悬空链接。'); }
      catch (statError) { if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function assertSystemBoundary(target: string): void {
  const roots = process.platform === 'win32'
    ? [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]
    : ['/bin', '/sbin', '/usr', '/etc', '/System', '/proc', '/sys', '/dev'];
  if (roots.some(root => root && containsPath(canonicalPath(root), target))) throw new Error(`拒绝访问受保护的系统路径：${target}`);
  const dataRoot = canonicalPath(path.join(app.getPath('userData'), 'ai-agent'));
  if (containsPath(dataRoot, target) && !containsPath(canonicalPath(artifactRoot()), target)) {
    throw new Error('Agent 不允许读取或修改应用配置、密钥、日志及恢复备份。');
  }
}

function userGrants(): WorkspaceGrant[] {
  let grants: WorkspaceGrant[];
  try { grants = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as WorkspaceGrant[]; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    // An old backup could contain a grant the user has already revoked.
    throw new Error('工作区授权数据无法读取，已停止文件访问；请修复授权数据后重试。');
  }
  if (!Array.isArray(grants) || grants.some(grant => !grant || typeof grant.id !== 'string' || typeof grant.root !== 'string' || !path.isAbsolute(grant.root) || path.dirname(grant.root) === grant.root ||
    typeof grant.allowWrite !== 'boolean' || typeof grant.allowDelete !== 'boolean')) throw new Error('工作区授权数据无效，请在工具权限中重新设置。');
  return grants;
}

export function listWorkspaces(): WorkspaceGrant[] {
  return [{ id: 'artifacts', root: artifactRoot(), allowWrite: true, allowDelete: true, builtin: true }, ...userGrants().map(grant => ({ ...grant, builtin: false }))];
}

export function addWorkspace(selectedFolder: string): WorkspaceGrant[] {
  if (isRestorePending()) throw new Error('备份恢复后请重启再修改授权。');
  const root = canonicalPath(selectedFolder);
  assertSystemBoundary(root);
  if (!fs.statSync(root).isDirectory() || path.dirname(root) === root) throw new Error('请选择具体的工作目录，不能授权整个磁盘。');
  const grants = userGrants();
  if (!grants.some(grant => grant.root === root)) {
    grants.push({ id: randomUUID(), root, allowWrite: false, allowDelete: false });
    atomicWriteJsonSync(storePath(), JSON.stringify(grants));
  }
  return listWorkspaces();
}

export function updateWorkspace(id: string, rights: { allowWrite: boolean; allowDelete: boolean } | null): WorkspaceGrant[] {
  if (isRestorePending()) throw new Error('备份恢复后请重启再修改授权。');
  if (rights !== null && (!rights || typeof rights.allowWrite !== 'boolean' || typeof rights.allowDelete !== 'boolean')) throw new Error('工作区权限格式无效。');
  const grants = userGrants();
  if (!grants.some(grant => grant.id === id)) throw new Error('授权不存在或不可修改。');
  const next = rights === null ? grants.filter(grant => grant.id !== id) : grants.map(grant => grant.id === id ? { ...grant, allowWrite: rights.allowWrite, allowDelete: rights.allowDelete } : grant);
  atomicWriteJsonSync(storePath(), JSON.stringify(next));
  return listWorkspaces();
}

export function assertWorkspaceAccess(input: string, access: FileAccess = 'read'): string {
  const lexical = path.resolve(input);
  const target = canonicalPath(input);
  assertSystemBoundary(target);
  const grants = listWorkspaces().filter(grant => {
    const anchor = path.resolve(grant.root);
    const realRoot = canonicalPath(grant.root);
    return path.relative(anchor, realRoot) === '' && containsPath(anchor, lexical) && containsPath(realRoot, target);
  });
  if (!grants.some(grant => access === 'read' || (access === 'write' ? grant.allowWrite : grant.allowDelete))) {
    throw new Error(`未授权${access === 'read' ? '读取' : access === 'write' ? '写入' : '删除'}路径：${input}。请在设置 → 工具权限中添加工作区并开启相应权限。`);
  }
  // Reject links even if they currently point inside the grant. Descendant
  // traversal also calls this check, so a later junction cannot widen access.
  const root = grants.sort((a, b) => b.root.length - a.root.length)[0].root;
  let cursor = lexical;
  while (containsPath(root, cursor)) {
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) throw new Error(`不允许通过符号链接或目录联接访问：${cursor}`);
      if (access !== 'read' && stat.isFile() && stat.nlink > 1) throw new Error(`不允许修改有多个硬链接的文件：${cursor}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  return target;
}

export function assertNotWorkspaceRoot(target: string): void {
  if (listWorkspaces().some(grant => path.relative(canonicalPath(grant.root), canonicalPath(target)) === '')) throw new Error('不能移动、删除或覆盖工作区根目录。');
}

export function describeWorkspaces(): string {
  return '文件工具仅允许访问以下工作区（路径外拒绝访问）：\n' + listWorkspaces().map(grant =>
    `- ${grant.root}：读取${grant.allowWrite ? '、写入' : ''}${grant.allowDelete ? '、删除' : ''}`,
  ).join('\n');
}
