import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

export type ToolRisk = "read" | "write" | "delete" | "network" | "system";

export type ToolPolicy = {
  name: string;
  risk: ToolRisk[];
  requiresConfirmation: boolean;
  description: string;
};

export const toolPolicies: Record<string, ToolPolicy> = {
  read_file: {
    name: "read_file",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Read a local text file with size and path guardrails.",
  },
  write_file: {
    name: "write_file",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Write a local file, rejecting protected system locations.",
  },
  append_file: {
    name: "append_file",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Append content to a local file, rejecting protected system locations.",
  },
  create_directory: {
    name: "create_directory",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Create a local directory, rejecting protected system locations.",
  },
  copy_file: {
    name: "copy_file",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Copy a local file, rejecting protected system locations.",
  },
  copy_directory: {
    name: "copy_directory",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Copy a local directory recursively, rejecting protected system locations.",
  },
  move_file: {
    name: "move_file",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Move or rename a local file, rejecting protected system locations.",
  },
  move_directory: {
    name: "move_directory",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Move or rename a local directory recursively, rejecting protected system locations.",
  },
  delete_file: {
    name: "delete_file",
    risk: ["delete"],
    requiresConfirmation: true,
    description: "Move a local file to the system trash instead of unlinking it.",
  },
  clipboard_copy: {
    name: "clipboard_copy",
    risk: ["system"],
    requiresConfirmation: false,
    description: "Copy text to the local clipboard.",
  },
  search_file_content: {
    name: "search_file_content",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Search text file contents under a local directory with guardrails.",
  },
  read_json: {
    name: "read_json",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Read and parse a local JSON file with size and path guardrails.",
  },
  read_csv: {
    name: "read_csv",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Read a local CSV file preview with size and path guardrails.",
  },
  file_exists: {
    name: "file_exists",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Check whether a local file or directory exists.",
  },
  path_stat: {
    name: "path_stat",
    risk: ["read"],
    requiresConfirmation: false,
    description: "Read metadata for a local file or directory.",
  },
  write_json: {
    name: "write_json",
    risk: ["write"],
    requiresConfirmation: false,
    description: "Write structured JSON data to a local file, rejecting protected system locations.",
  },
  insert_into_file: {
    name: "insert_into_file",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Insert text near a specific line in a local text file.",
  },
  replace_in_file: {
    name: "replace_in_file",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Replace text in a local text file with size and path guardrails.",
  },
  replace_regex_in_file: {
    name: "replace_regex_in_file",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Replace text in a local text file using a regular expression.",
  },
  make_zip: {
    name: "make_zip",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Create a zip archive from a local file or directory.",
  },
  open_url: {
    name: "open_url",
    risk: ["system"],
    requiresConfirmation: false,
    description: "Open an http or https URL in the system default browser.",
  },
  extract_zip: {
    name: "extract_zip",
    risk: ["read", "write"],
    requiresConfirmation: false,
    description: "Extract a zip archive to a local directory.",
  },
  reveal_in_folder: {
    name: "reveal_in_folder",
    risk: ["system"],
    requiresConfirmation: false,
    description: "Reveal a local file or directory in the system file explorer.",
  },
  open_path: {
    name: "open_path",
    risk: ["system"],
    requiresConfirmation: false,
    description: "Open a local file or directory with the system default application or file explorer.",
  },
  get_os_info: {
    name: "get_os_info",
    risk: ["system"],
    requiresConfirmation: false,
    description: "Read the local operating system name, version, build, and architecture.",
  },
  web_search: {
    name: "web_search",
    risk: ["network"],
    requiresConfirmation: false,
    description: "Search public web results.",
  },
  fetch_url: {
    name: "fetch_url",
    risk: ["network"],
    requiresConfirmation: false,
    description: "Fetch a public URL.",
  },
};

const MAX_READ_BYTES = 1_000_000;

function normalizeForCompare(filePath: string): string {
  return path.resolve(filePath).toLowerCase();
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
    throw new Error("Path is required.");
  }
  return path.resolve(inputPath);
}

export function assertNotProtectedPath(resolvedPath: string): void {
  const normalized = normalizeForCompare(resolvedPath);
  const protectedRoot = getProtectedRoots().find(
    (root) => normalized === root || normalized.startsWith(`${root}${path.sep}`),
  );

  if (protectedRoot) {
    throw new Error(`Refusing to access protected system path: ${resolvedPath}`);
  }
}

export function assertReadableFile(resolvedPath: string): void {
  assertNotProtectedPath(resolvedPath);

  const stat = fs.statSync(resolvedPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${resolvedPath}`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(
      `File is too large to read directly (${stat.size} bytes). Limit is ${MAX_READ_BYTES} bytes.`,
    );
  }
}

export function ensureWritableTarget(resolvedPath: string): void {
  assertNotProtectedPath(resolvedPath);
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
      const approval = policy.requiresConfirmation ? "approval required" : "auto";
      return `- ${policy.name}: ${policy.risk.join(", ")}; ${approval}; ${policy.description}`;
    })
    .join("\n");
}

export function listToolPolicies(): ToolPolicy[] {
  return Object.values(toolPolicies).map((policy) => ({ ...policy }));
}
