import JSZip from 'jszip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { assertWorkspaceAccess, containsPath } from './workspaces';
import { throwIfToolAborted } from './toolContext';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 2000;

export async function createWorkspaceZip(source: string, target: string, overwrite = false): Promise<void> {
  assertWorkspaceAccess(source, 'read');
  assertWorkspaceAccess(target, 'write');
  if (containsPath(source, target) || containsPath(target, source)) throw new Error('ZIP 路径不能与源路径相同或互相包含。');
  if (fs.existsSync(target) && !overwrite) throw new Error('ZIP 文件已存在。');
  const zip = new JSZip();
  let bytes = 0, count = 0;
  const visit = (current: string, name: string): void => {
    throwIfToolAborted();
    assertWorkspaceAccess(current, 'read');
    const stat = fs.lstatSync(current);
    if (++count > MAX_ENTRIES) throw new Error('ZIP 内容超过 2000 个条目。');
    if (stat.isDirectory()) {
      zip.folder(name);
      for (const child of fs.readdirSync(current)) visit(path.join(current, child), `${name}/${child}`);
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('ZIP 只接受普通文件和目录。');
      bytes += stat.size;
      if (bytes > MAX_BYTES) throw new Error('ZIP 源文件总量超过 50 MiB。');
      zip.file(name, fs.readFileSync(current));
    }
  };
  visit(source, path.basename(source));
  const data = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  throwIfToolAborted();
  if (data.length > MAX_BYTES) throw new Error('ZIP 输出超过 50 MiB。');
  assertWorkspaceAccess(target, 'write');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Never remove the existing archive before generation succeeds.
  const temporary = path.join(path.dirname(target), `.centibot-zip-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx' });
    if (!overwrite && fs.existsSync(target)) throw new Error('ZIP 目标已发生变化。');
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export async function extractWorkspaceZip(source: string, target: string): Promise<void> {
  assertWorkspaceAccess(source, 'read');
  assertWorkspaceAccess(target, 'write');
  if (fs.existsSync(target)) throw new Error('目标目录已存在，请选择新目录，原内容不会被删除。');
  if (fs.statSync(source).size > MAX_BYTES) throw new Error('ZIP 输入超过 50 MiB。');
  const zip = await JSZip.loadAsync(fs.readFileSync(source));
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error('ZIP 条目超过 2000 个。');
  let bytes = 0;
  const outputs: Array<{ name: string; data?: Buffer }> = [];
  const names = new Set<string>();
  for (const entry of entries) {
    throwIfToolAborted();
    const rawName = (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    const parts = rawName.replace(/\\/g, '/').replace(/\/$/, '').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[:\x00-\x1f<>"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`ZIP 包含不安全的路径：${rawName}`);
    const mode = Number(entry.unixPermissions ?? 0) & 0o170000;
    if (mode && mode !== 0o100000 && mode !== 0o040000) throw new Error('ZIP 包含链接或特殊设备条目。');
    const name = parts.join(path.sep);
    const key = process.platform === 'win32' ? name.toLowerCase() : name;
    if (names.has(key)) throw new Error('ZIP 包含重复目标路径。');
    names.add(key);
    const destination = path.join(target, name);
    if (!containsPath(target, destination)) throw new Error('ZIP 路径越界。');
    assertWorkspaceAccess(destination, 'write');
    if (entry.dir) { outputs.push({ name }); continue; }
    // Bound decompression while streaming; do not allocate an unbounded buffer
    // from the archive's claimed uncompressed size.
    const data = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = entry.nodeStream('nodebuffer') as Readable;
      stream.on('data', (chunk: Buffer) => {
        try {
          throwIfToolAborted();
          bytes += chunk.length;
          if (bytes > MAX_BYTES) throw new Error('ZIP 解压内容超过 50 MiB。');
          chunks.push(chunk);
        } catch (error) { stream.destroy(); reject(error); }
      }).on('error', reject).on('end', () => resolve(Buffer.concat(chunks))).resume();
    });
    outputs.push({ name, data });
  }
  throwIfToolAborted();
  assertWorkspaceAccess(target, 'write');
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const staging = path.join(parent, `.centibot-extract-${randomUUID()}`);
  assertWorkspaceAccess(staging, 'write');
  fs.mkdirSync(staging);
  try {
    for (const output of outputs) {
      throwIfToolAborted();
      const destination = path.join(staging, output.name);
      assertWorkspaceAccess(destination, 'write');
      if (!output.data) fs.mkdirSync(destination, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, output.data, { flag: 'wx' });
      }
    }
    assertWorkspaceAccess(target, 'write');
    if (fs.existsSync(target)) throw new Error('解压目标在执行期间已被创建，已停止覆盖。');
    fs.renameSync(staging, target);
  } finally {
    // Only remove the fixed staging directory created above, never the target.
    if (fs.existsSync(staging) && containsPath(parent, staging)) {
      assertWorkspaceAccess(staging, 'write');
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
}
