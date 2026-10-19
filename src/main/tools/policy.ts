import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { atomicWriteJsonSync, readJsonWithBackup } from '../runtime/persistence';
import { isRestorePending } from '../storage';
import { assertWorkspaceAccess } from '../runtime/workspaces';

export type ToolRisk = "read" | "write" | "delete" | "network" | "system";

export type ToolPolicy = {
  name: string;
  displayName: string;
  risk: ToolRisk[];
  requiresConfirmation: boolean;
  description: string;
};

export const toolPolicies: Record<string, ToolPolicy> = {
  get_current_time: { name: 'get_current_time', displayName: '获取时间', risk: ['read'], requiresConfirmation: false, description: '读取当前日期与时间。' },
  calculator: { name: 'calculator', displayName: '计算器', risk: ['read'], requiresConfirmation: false, description: '计算数学表达式。' },
  unit_convert: { name: 'unit_convert', displayName: '单位换算', risk: ['read'], requiresConfirmation: false, description: '执行单位换算。' },
  list_running_apps: { name: 'list_running_apps', displayName: '查看运行应用', risk: ['read'], requiresConfirmation: false, description: '读取正在运行的应用信息。' },
  list_special_folder: { name: 'list_special_folder', displayName: '查看常用目录', risk: ['read'], requiresConfirmation: false, description: '读取系统常用文件夹位置。' },
  list_directory: { name: 'list_directory', displayName: '列出目录', risk: ['read'], requiresConfirmation: false, description: '列出本地目录内容。' },
  search_files: { name: 'search_files', displayName: '搜索文件', risk: ['read'], requiresConfirmation: false, description: '按名称搜索本地文件。' },
  get_weather_current: { name: 'get_weather_current', displayName: '查询天气', risk: ['network'], requiresConfirmation: false, description: '向天气服务查询实时天气。' },
  currency_convert: { name: 'currency_convert', displayName: '汇率换算', risk: ['network'], requiresConfirmation: false, description: '查询在线汇率并换算。' },
  generate_pdf: { name: 'generate_pdf', displayName: '生成 PDF', risk: ['write'], requiresConfirmation: false, description: '在本地生成 PDF 文件。' },
  generate_pptx: { name: 'generate_pptx', displayName: '生成 PPTX', risk: ['write'], requiresConfirmation: false, description: '在本地生成 PowerPoint 文件。' },
  read_file: {
    name: "read_file",
    displayName: "读取文件",
    risk: ["read"],
    requiresConfirmation: false,
    description: "读取本地文本文件，限制文件大小和路径安全范围。",
  },
  write_file: {
    name: "write_file",
    displayName: "写入文件",
    risk: ["write"],
    requiresConfirmation: false,
    description: "写入本地文件，拒绝访问系统保护路径。",
  },
  append_file: {
    name: "append_file",
    displayName: "追加文件",
    risk: ["write"],
    requiresConfirmation: false,
    description: "向本地文件末尾追加内容，拒绝访问系统保护路径。",
  },
  create_directory: {
    name: "create_directory",
    displayName: "创建目录",
    risk: ["write"],
    requiresConfirmation: false,
    description: "在本地创建目录，拒绝访问系统保护路径。",
  },
  copy_file: {
    name: "copy_file",
    displayName: "复制文件",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "复制本地文件，拒绝访问系统保护路径。",
  },
  copy_directory: {
    name: "copy_directory",
    displayName: "复制目录",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "递归复制本地目录，拒绝访问系统保护路径。",
  },
  move_file: {
    name: "move_file",
    displayName: "移动文件",
    risk: ["write"],
    requiresConfirmation: false,
    description: "移动或重命名本地文件，拒绝访问系统保护路径。",
  },
  move_directory: {
    name: "move_directory",
    displayName: "移动目录",
    risk: ["write"],
    requiresConfirmation: false,
    description: "递归移动或重命名本地目录，拒绝访问系统保护路径。",
  },
  delete_file: {
    name: "delete_file",
    displayName: "删除文件",
    risk: ["delete"],
    requiresConfirmation: true,
    description: "将本地文件移入回收站，不会直接永久删除。",
  },
  clipboard_copy: {
    name: "clipboard_copy",
    displayName: "复制到剪贴板",
    risk: ["system"],
    requiresConfirmation: false,
    description: "将文本复制到系统剪贴板。",
  },
  search_file_content: {
    name: "search_file_content",
    displayName: "搜索文件内容",
    risk: ["read"],
    requiresConfirmation: false,
    description: "在本地目录中按文本内容搜索文件，限制访问范围。",
  },
  read_json: {
    name: "read_json",
    displayName: "读取 JSON 文件",
    risk: ["read"],
    requiresConfirmation: false,
    description: "读取并解析本地 JSON 文件，限制文件大小和路径安全范围。",
  },
  read_csv: {
    name: "read_csv",
    displayName: "读取 CSV 文件",
    risk: ["read"],
    requiresConfirmation: false,
    description: "读取本地 CSV 文件预览内容，限制文件大小和路径安全范围。",
  },
  file_exists: {
    name: "file_exists",
    displayName: "检查文件是否存在",
    risk: ["read"],
    requiresConfirmation: false,
    description: "检查本地文件或目录是否存在。",
  },
  path_stat: {
    name: "path_stat",
    displayName: "读取文件元数据",
    risk: ["read"],
    requiresConfirmation: false,
    description: "读取本地文件或目录的元数据（大小、修改时间等）。",
  },
  write_json: {
    name: "write_json",
    displayName: "写入 JSON 文件",
    risk: ["write"],
    requiresConfirmation: false,
    description: "将结构化 JSON 数据写入本地文件，拒绝访问系统保护路径。",
  },
  insert_into_file: {
    name: "insert_into_file",
    displayName: "插入文件内容",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "在本地文本文件的指定行附近插入文本。",
  },
  replace_in_file: {
    name: "replace_in_file",
    displayName: "替换文件内容",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "替换本地文本文件中的指定内容，限制文件大小和路径安全范围。",
  },
  replace_regex_in_file: {
    name: "replace_regex_in_file",
    displayName: "正则替换文件内容",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "使用正则表达式替换本地文本文件中的内容。",
  },
  make_zip: {
    name: "make_zip",
    displayName: "压缩为 ZIP",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "将本地文件或目录打包为 ZIP 压缩包。",
  },
  open_url: {
    name: "open_url",
    displayName: "打开网页链接",
    risk: ["system", "network"],
    requiresConfirmation: false,
    description: "在系统默认浏览器中打开 HTTP/HTTPS 链接。",
  },
  extract_zip: {
    name: "extract_zip",
    displayName: "解压 ZIP",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "将 ZIP 压缩包解压到本地目录。",
  },
  reveal_in_folder: {
    name: "reveal_in_folder",
    displayName: "在文件夹中显示",
    risk: ["system"],
    requiresConfirmation: false,
    description: "在系统文件资源管理器中定位并高亮显示本地文件或目录。",
  },
  open_path: {
    name: "open_path",
    displayName: "打开文件或目录",
    risk: ["system"],
    requiresConfirmation: false,
    description: "使用系统默认程序或文件资源管理器打开本地文件或目录。",
  },
  get_os_info: {
    name: "get_os_info",
    displayName: "获取系统信息",
    risk: ["read"],
    requiresConfirmation: false,
    description: "读取本机操作系统的名称、版本、构建号和架构信息。",
  },
  web_search: {
    name: "web_search",
    displayName: "网页搜索",
    risk: ["network"],
    requiresConfirmation: false,
    description: "搜索公开网页信息。",
  },
  fetch_url: {
    name: "fetch_url",
    displayName: "抓取网页内容",
    risk: ["network"],
    requiresConfirmation: false,
    description: "抓取公开 URL 的标题和正文摘要。",
  },
};

const TOOL_POLICY_STORE_DIR = path.join(app.getPath("userData"), "ai-agent");
const TOOL_POLICY_STORE_PATH = path.join(
  TOOL_POLICY_STORE_DIR,
  "tool-policies.json",
);

const MAX_READ_BYTES = 1_000_000;

function normalizeForCompare(filePath: string): string {
  return process.platform === 'win32' ? path.resolve(filePath).toLowerCase() : path.resolve(filePath);
}

function getProtectedRoots(): string[] {
  const roots = [
    process.env.SystemRoot,
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    process.env.ProgramData,
  ].filter((item): item is string => Boolean(item));

  return roots.map(normalizeForCompare);
}

export function resolveToolPath(inputPath: string): string {
  if (!inputPath || !inputPath.trim()) {
    throw new Error("路径不能为空。");
  }
  return path.resolve(inputPath);
}

export function assertNotProtectedPath(resolvedPath: string): void {
  assertWorkspaceAccess(resolvedPath, 'read');
  const normalized = normalizeForCompare(resolvedPath);
  const protectedRoot = getProtectedRoots().find(
    (root) =>
      normalized === root || normalized.startsWith(`${root}${path.sep}`),
  );

  if (protectedRoot) {
    throw new Error(
      `拒绝访问受保护的系统路径：${resolvedPath}`,
    );
  }
}

export function assertReadableFile(resolvedPath: string): void {
  assertNotProtectedPath(resolvedPath);

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`不是文件：${resolvedPath}`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `文件过大，无法直接读取（${stat.size} 字节），限制为 ${MAX_READ_BYTES} 字节。`,
    );
  }
}

export function ensureWritableTarget(resolvedPath: string): void {
  assertWorkspaceAccess(resolvedPath, 'write');
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function getDefaultArtifactDir(): string {
  const dir = path.join(app.getPath("userData"), "ai-agent", "artifacts");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function summarizeToolPolicies(): string {
  return Object.values(toolPolicies)
    .map((policy) => {
      const approval = policy.requiresConfirmation
        ? "approval required"
        : "auto";
      return `- ${policy.name}: ${policy.risk.join(", ")}; ${approval}; ${policy.description}`;
    })
    .join("\n");
}

export function listToolPolicies(): ToolPolicy[] {
  return Object.values(toolPolicies).map((policy) => ({ ...policy }));
}

function persistToolPolicies(policies = toolPolicies): void {
  if (!fs.existsSync(TOOL_POLICY_STORE_DIR)) {
    fs.mkdirSync(TOOL_POLICY_STORE_DIR, { recursive: true });
  }

  const snapshot = Object.fromEntries(
    Object.values(policies).map((policy) => [
      policy.name,
      { requiresConfirmation: policy.requiresConfirmation },
    ]),
  );

  atomicWriteJsonSync(
    TOOL_POLICY_STORE_PATH,
    JSON.stringify(snapshot, null, 2),
  );
}

function hydrateToolPolicies(): void {
  try {
    const parsed = readJsonWithBackup<Record<
      string,
      { requiresConfirmation?: boolean }
    >>(TOOL_POLICY_STORE_PATH, {});

    for (const [name, value] of Object.entries(parsed)) {
      if (
        !toolPolicies[name] ||
        typeof value?.requiresConfirmation !== "boolean"
      ) {
        continue;
      }

      toolPolicies[name] = {
        ...toolPolicies[name],
        requiresConfirmation: value.requiresConfirmation,
      };
    }
  } catch {
    // Ignore invalid persisted policy data and fall back to defaults.
  }
}

export function updateToolPolicy(
  name: string,
  requiresConfirmation: boolean,
): boolean {
  if (!toolPolicies[name]) return false;
  updateToolPolicies({ [name]: requiresConfirmation });
  return true;
}

export function updateToolPolicies(patches: Record<string, boolean>): ToolPolicy[] {
  if (isRestorePending()) throw new Error('备份已恢复，请重启应用后修改权限。');
  const next = { ...toolPolicies };
  for (const [name, requiresConfirmation] of Object.entries(patches)) {
    if (!next[name] || typeof requiresConfirmation !== 'boolean') throw new Error(`无效工具权限：${name}`);
    next[name] = { ...next[name], requiresConfirmation };
  }
  persistToolPolicies(next);
  Object.assign(toolPolicies, next);
  return listToolPolicies();
}

hydrateToolPolicies();
