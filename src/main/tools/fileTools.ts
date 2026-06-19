import { shell } from "electron";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { execFile } from "node:child_process";
import * as fs from "fs";
import * as path from "path";
import {
  assertNotProtectedPath,
  assertReadableFile,
  ensureWritableTarget,
  resolveToolPath,
} from "./policy";

function toToolError(action: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${action}失败：${message}`;
}

function execFileUtf8(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error((stderr || error.message || "").trim()));
          return;
        }
        resolve(String(stdout || "").trim());
      },
    );
  });
}

export const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      return `文件读取成功（${lines} 行）：\n\`\`\`\n${content}\n\`\`\``;
    } catch (error) {
      return toToolError("读取文件", error);
    }
  },
  {
    name: "read_file",
    description:
      "Read a local text file. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Absolute or relative path of the file to read."),
    }),
  },
);

export const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      ensureWritableTarget(resolvedPath);
      fs.writeFileSync(resolvedPath, content, "utf-8");
      return `文件写入成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("写入文件", error);
    }
  },
  {
    name: "write_file",
    description:
      "Write content to a local file. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to write."),
      content: z.string().describe("Content to write."),
    }),
  },
);

export const appendFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      ensureWritableTarget(resolvedPath);
      fs.appendFileSync(resolvedPath, content, "utf-8");
      return `文件追加成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("追加文件", error);
    }
  },
  {
    name: "append_file",
    description:
      "Append content to a local file. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to append to."),
      content: z.string().describe("Content to append."),
    }),
  },
);

export const createDirectoryTool = tool(
  async ({ dirPath }) => {
    try {
      const resolvedPath = resolveToolPath(dirPath);
      ensureWritableTarget(path.join(resolvedPath, ".keep"));
      fs.mkdirSync(resolvedPath, { recursive: true });
      return `目录创建成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("创建目录", error);
    }
  },
  {
    name: "create_directory",
    description:
      "Create a local directory. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      dirPath: z.string().describe("Path of the directory to create."),
    }),
  },
);

export const copyFileTool = tool(
  async ({ sourcePath, destinationPath, overwrite }) => {
    try {
      const resolvedSourcePath = resolveToolPath(sourcePath);
      const resolvedDestinationPath = resolveToolPath(destinationPath);
      assertNotProtectedPath(resolvedSourcePath);
      ensureWritableTarget(resolvedDestinationPath);

      if (!fs.existsSync(resolvedSourcePath)) {
        return `源路径不存在：${resolvedSourcePath}`;
      }

      const stat = fs.statSync(resolvedSourcePath);
      if (!stat.isFile()) {
        return `拒绝复制非文件路径：${resolvedSourcePath}`;
      }

      if (fs.existsSync(resolvedDestinationPath) && !overwrite) {
        return `目标路径已存在：${resolvedDestinationPath}`;
      }

      fs.copyFileSync(
        resolvedSourcePath,
        resolvedDestinationPath,
        overwrite ? 0 : fs.constants.COPYFILE_EXCL,
      );
      return `文件复制成功：${resolvedSourcePath} -> ${resolvedDestinationPath}`;
    } catch (error) {
      return toToolError("复制文件", error);
    }
  },
  {
    name: "copy_file",
    description:
      "Copy a local file. Parent directories are created automatically; protected system paths and directories are refused.",
    schema: z.object({
      sourcePath: z.string().describe("Current path of the file."),
      destinationPath: z.string().describe("Destination path of the copied file."),
      overwrite: z.boolean().optional().describe("Whether to overwrite the destination if it exists."),
    }),
  },
);

function copyDirectoryRecursive(sourceDir: string, destinationDir: string): void {
  fs.mkdirSync(destinationDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(sourcePath, destinationPath);
      continue;
    }

    if (entry.isFile()) {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

export const listDirectoryTool = tool(
  async ({ dirPath }) => {
    try {
      const resolvedPath = resolveToolPath(dirPath);
      assertNotProtectedPath(resolvedPath);
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      const result = entries.slice(0, 200).map((entry) => {
        const type = entry.isDirectory() ? "[dir]" : "[file]";
        const size = entry.isFile()
          ? ` (${fs.statSync(path.join(resolvedPath, entry.name)).size} bytes)`
          : "";
        return `${type} ${entry.name}${size}`;
      });
      const truncated =
        entries.length > result.length ? `\n... 已省略 ${entries.length - result.length} 个条目` : "";
      return `目录“${resolvedPath}”内容如下：\n${result.join("\n")}${truncated}`;
    } catch (error) {
      return toToolError("列出目录", error);
    }
  },
  {
    name: "list_directory",
    description:
      "List files and subdirectories in a directory. Protected system paths are refused.",
    schema: z.object({
      dirPath: z.string().describe("Directory path to list."),
    }),
  },
);

export const copyDirectoryTool = tool(
  async ({ sourcePath, destinationPath, overwrite }) => {
    try {
      const resolvedSourcePath = resolveToolPath(sourcePath);
      const resolvedDestinationPath = resolveToolPath(destinationPath);
      assertNotProtectedPath(resolvedSourcePath);
      ensureWritableTarget(path.join(resolvedDestinationPath, ".keep"));

      if (!fs.existsSync(resolvedSourcePath)) {
        return `源路径不存在：${resolvedSourcePath}`;
      }

      const stat = fs.statSync(resolvedSourcePath);
      if (!stat.isDirectory()) {
        return `拒绝复制非目录路径：${resolvedSourcePath}`;
      }

      if (fs.existsSync(resolvedDestinationPath)) {
        if (!overwrite) {
          return `目标路径已存在：${resolvedDestinationPath}`;
        }
        fs.rmSync(resolvedDestinationPath, { recursive: true, force: true });
      }

      copyDirectoryRecursive(resolvedSourcePath, resolvedDestinationPath);
      return `目录复制成功：${resolvedSourcePath} -> ${resolvedDestinationPath}`;
    } catch (error) {
      return toToolError("复制目录", error);
    }
  },
  {
    name: "copy_directory",
    description:
      "Copy a local directory recursively. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      sourcePath: z.string().describe("Current path of the directory."),
      destinationPath: z.string().describe("Destination path of the copied directory."),
      overwrite: z.boolean().optional().describe("Whether to overwrite the destination if it exists."),
    }),
  },
);

export const moveFileTool = tool(
  async ({ sourcePath, destinationPath }) => {
    try {
      const resolvedSourcePath = resolveToolPath(sourcePath);
      const resolvedDestinationPath = resolveToolPath(destinationPath);
      assertNotProtectedPath(resolvedSourcePath);
      ensureWritableTarget(resolvedDestinationPath);

      if (!fs.existsSync(resolvedSourcePath)) {
        return `源路径不存在：${resolvedSourcePath}`;
      }

      const stat = fs.statSync(resolvedSourcePath);
      if (!stat.isFile()) {
        return `拒绝移动非文件路径：${resolvedSourcePath}`;
      }

      fs.renameSync(resolvedSourcePath, resolvedDestinationPath);
      return `文件移动成功：${resolvedSourcePath} -> ${resolvedDestinationPath}`;
    } catch (error) {
      return toToolError("移动文件", error);
    }
  },
  {
    name: "move_file",
    description:
      "Move or rename a local file. Parent directories are created automatically; protected system paths and directories are refused.",
    schema: z.object({
      sourcePath: z.string().describe("Current path of the file."),
      destinationPath: z.string().describe("Destination path of the file."),
    }),
  },
);

export const moveDirectoryTool = tool(
  async ({ sourcePath, destinationPath, overwrite }) => {
    try {
      const resolvedSourcePath = resolveToolPath(sourcePath);
      const resolvedDestinationPath = resolveToolPath(destinationPath);
      assertNotProtectedPath(resolvedSourcePath);
      ensureWritableTarget(path.join(resolvedDestinationPath, ".keep"));

      if (!fs.existsSync(resolvedSourcePath)) {
        return `源路径不存在：${resolvedSourcePath}`;
      }

      const stat = fs.statSync(resolvedSourcePath);
      if (!stat.isDirectory()) {
        return `拒绝移动非目录路径：${resolvedSourcePath}`;
      }

      if (fs.existsSync(resolvedDestinationPath)) {
        if (!overwrite) {
          return `目标路径已存在：${resolvedDestinationPath}`;
        }
        fs.rmSync(resolvedDestinationPath, { recursive: true, force: true });
      }

      fs.renameSync(resolvedSourcePath, resolvedDestinationPath);
      return `目录移动成功：${resolvedSourcePath} -> ${resolvedDestinationPath}`;
    } catch (error) {
      return toToolError("移动目录", error);
    }
  },
  {
    name: "move_directory",
    description:
      "Move or rename a local directory recursively. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      sourcePath: z.string().describe("Current path of the directory."),
      destinationPath: z.string().describe("Destination path of the directory."),
      overwrite: z.boolean().optional().describe("Whether to overwrite the destination if it exists."),
    }),
  },
);

export const deleteFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertNotProtectedPath(resolvedPath);
      if (!fs.existsSync(resolvedPath)) {
        return `文件不存在：${resolvedPath}`;
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return `拒绝删除非文件路径：${resolvedPath}`;
      }

      await shell.trashItem(resolvedPath);
      return `文件删除成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("删除文件", error);
    }
  },
  {
    name: "delete_file",
    description:
      "Move a local file to the system trash. Protected system paths and directories are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to move to trash."),
    }),
  },
);

export const searchFilesTool = tool(
  async ({ dirPath, keyword }) => {
    try {
      const resolvedPath = resolveToolPath(dirPath);
      assertNotProtectedPath(resolvedPath);
      const results: string[] = [];
      const normalizedKeyword = keyword.toLowerCase();

      const searchDir = (dir: string, depth: number): void => {
        if (results.length >= 50 || depth > 8) return;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                searchDir(fullPath, depth + 1);
              }
            } else if (entry.name.toLowerCase().includes(normalizedKeyword)) {
              results.push(fullPath);
            }
            if (results.length >= 50) return;
          }
        } catch {
          // Ignore inaccessible child directories.
        }
      };

      searchDir(resolvedPath, 0);
      if (results.length === 0) {
        return `在“${resolvedPath}”中未找到包含“${keyword}”的文件。`;
      }
      return `共找到 ${results.length} 个文件：\n${results.join("\n")}`;
    } catch (error) {
      return toToolError("搜索文件", error);
    }
  },
  {
    name: "search_files",
    description:
      "Search file names under a directory. Hidden directories, node_modules, deep recursion, and protected system paths are skipped.",
    schema: z.object({
      dirPath: z.string().describe("Directory path to search."),
      keyword: z.string().describe("Keyword to match in file names."),
    }),
  },
);

export const searchFileContentTool = tool(
  async ({ dirPath, keyword }) => {
    try {
      const resolvedPath = resolveToolPath(dirPath);
      assertNotProtectedPath(resolvedPath);
      const matches: string[] = [];
      const normalizedKeyword = keyword.toLowerCase();
      const textExtensions = new Set([
        ".txt",
        ".md",
        ".json",
        ".csv",
        ".js",
        ".ts",
        ".tsx",
        ".jsx",
        ".html",
        ".css",
        ".scss",
        ".yml",
        ".yaml",
        ".xml",
        ".log",
      ]);

      const walk = (dir: string, depth: number): void => {
        if (matches.length >= 30 || depth > 6) return;

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
              walk(fullPath, depth + 1);
            }
            continue;
          }

          if (!textExtensions.has(path.extname(entry.name).toLowerCase())) {
            continue;
          }

          try {
            const stat = fs.statSync(fullPath);
            if (stat.size > 200_000) continue;
            const content = fs.readFileSync(fullPath, "utf-8");
            const lines = content.split(/\r?\n/);

            for (let index = 0; index < lines.length; index++) {
              const line = lines[index];
              if (line.toLowerCase().includes(normalizedKeyword)) {
                matches.push(`${fullPath}:${index + 1}: ${line.trim()}`);
                if (matches.length >= 30) return;
              }
            }
          } catch {
            // Ignore unreadable or non-UTF8 files.
          }
        }
      };

      walk(resolvedPath, 0);

      if (matches.length === 0) {
        return `在“${resolvedPath}”中未找到包含“${keyword}”的文件内容。`;
      }

      return `共找到 ${matches.length} 处内容匹配：\n${matches.join("\n")}`;
    } catch (error) {
      return toToolError("搜索文件内容", error);
    }
  },
  {
    name: "search_file_content",
    description:
      "Search text file contents under a directory and return matching lines. Hidden directories, node_modules, large files, deep recursion, and protected system paths are skipped.",
    schema: z.object({
      dirPath: z.string().describe("Directory path to search in."),
      keyword: z.string().describe("Keyword to match in file contents."),
    }),
  },
);

export const readJsonTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      const raw = fs.readFileSync(resolvedPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      return `JSON 读取成功：\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
    } catch (error) {
      return toToolError("读取 JSON", error);
    }
  },
  {
    name: "read_json",
    description:
      "Read and parse a local JSON file. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the JSON file to read."),
    }),
  },
);

export const writeJsonTool = tool(
  async ({ filePath, data, pretty }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      ensureWritableTarget(resolvedPath);
      const spaces = pretty === false ? 0 : 2;
      fs.writeFileSync(resolvedPath, JSON.stringify(data, null, spaces), "utf-8");
      return `JSON 写入成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("写入 JSON", error);
    }
  },
  {
    name: "write_json",
    description:
      "Write structured JSON data to a local file. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the JSON file to write."),
      data: z.unknown().describe("Structured data to serialize as JSON."),
      pretty: z.boolean().optional().describe("Whether to pretty-print JSON. Defaults to true."),
    }),
  },
);

export const fileExistsTool = tool(
  async ({ targetPath }) => {
    try {
      const resolvedPath = resolveToolPath(targetPath);
      assertNotProtectedPath(resolvedPath);
      return fs.existsSync(resolvedPath)
        ? `路径存在：${resolvedPath}`
        : `路径不存在：${resolvedPath}`;
    } catch (error) {
      return toToolError("检查路径", error);
    }
  },
  {
    name: "file_exists",
    description:
      "Check whether a local file or directory exists. Protected system paths are refused.",
    schema: z.object({
      targetPath: z.string().describe("Path of the local file or directory to check."),
    }),
  },
);

export const pathStatTool = tool(
  async ({ targetPath }) => {
    try {
      const resolvedPath = resolveToolPath(targetPath);
      assertNotProtectedPath(resolvedPath);

      if (!fs.existsSync(resolvedPath)) {
        return `路径不存在：${resolvedPath}`;
      }

      const stat = fs.statSync(resolvedPath);
      return [
        `路径：${resolvedPath}`,
        `类型：${stat.isDirectory() ? "目录" : stat.isFile() ? "文件" : "其他"}`,
        `大小：${stat.size} 字节`,
        `创建时间：${stat.birthtime.toISOString()}`,
        `修改时间：${stat.mtime.toISOString()}`,
      ].join("\n");
    } catch (error) {
      return toToolError("读取路径信息", error);
    }
  },
  {
    name: "path_stat",
    description:
      "Read metadata for a local file or directory, including type, size, and timestamps.",
    schema: z.object({
      targetPath: z.string().describe("Path of the local file or directory."),
    }),
  },
);

export const readCsvTool = tool(
  async ({ filePath, maxRows }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      const raw = fs.readFileSync(resolvedPath, "utf-8");
      const rows = raw
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .slice(0, Math.max(1, Math.min(maxRows ?? 20, 100)));

      return `CSV 预览（${rows.length} 行）：\n\`\`\`\n${rows.join("\n")}\n\`\`\``;
    } catch (error) {
      return toToolError("读取 CSV", error);
    }
  },
  {
    name: "read_csv",
    description:
      "Read a local CSV file and return a preview of rows. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the CSV file to read."),
      maxRows: z.number().int().min(1).max(100).optional().describe("Maximum number of rows to preview."),
    }),
  },
);

export const insertIntoFileTool = tool(
  async ({ filePath, text, lineNumber, position }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      ensureWritableTarget(resolvedPath);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split(/\r?\n/);
      const safeLineNumber = Math.max(1, Math.min(lineNumber, lines.length + 1));
      const index = safeLineNumber - 1;

      if (position === "before") {
        lines.splice(index, 0, text);
      } else {
        lines.splice(index + 1, 0, text);
      }

      fs.writeFileSync(resolvedPath, lines.join("\n"), "utf-8");
      return `文本插入成功：${resolvedPath}（第 ${safeLineNumber} 行，${position === "before" ? "之前" : "之后"}）`;
    } catch (error) {
      return toToolError("插入文件内容", error);
    }
  },
  {
    name: "insert_into_file",
    description:
      "Insert text before or after a specific line in a local text file. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to edit."),
      text: z.string().describe("Text to insert as a new line."),
      lineNumber: z.number().int().min(1).describe("1-based line number to insert near."),
      position: z.enum(["before", "after"]).describe("Whether to insert before or after the line."),
    }),
  },
);

export const replaceInFileTool = tool(
  async ({ filePath, searchText, replaceText, replaceAll }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      ensureWritableTarget(resolvedPath);

      const content = fs.readFileSync(resolvedPath, "utf-8");
      if (!content.includes(searchText)) {
        return `文件中未找到要替换的文本：${resolvedPath}`;
      }

      const nextContent = replaceAll
        ? content.split(searchText).join(replaceText)
        : content.replace(searchText, replaceText);

      fs.writeFileSync(resolvedPath, nextContent, "utf-8");
      return `文件内容替换成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("替换文件内容", error);
    }
  },
  {
    name: "replace_in_file",
    description:
      "Replace text in a local text file. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to edit."),
      searchText: z.string().describe("Text to search for."),
      replaceText: z.string().describe("Replacement text."),
      replaceAll: z.boolean().optional().describe("Whether to replace all matches. Defaults to false."),
    }),
  },
);

export const replaceRegexInFileTool = tool(
  async ({ filePath, pattern, replaceText, flags }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      ensureWritableTarget(resolvedPath);

      const regex = new RegExp(pattern, flags || "");
      const content = fs.readFileSync(resolvedPath, "utf-8");
      if (!regex.test(content)) {
        return `文件中未找到匹配的正则表达式：${resolvedPath}`;
      }

      const nextContent = content.replace(new RegExp(pattern, flags || ""), replaceText);
      fs.writeFileSync(resolvedPath, nextContent, "utf-8");
      return `正则替换成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("正则替换文件内容", error);
    }
  },
  {
    name: "replace_regex_in_file",
    description:
      "Replace text in a local file using a regular expression. Protected system paths and files larger than 1 MB are refused.",
    schema: z.object({
      filePath: z.string().describe("Path of the file to edit."),
      pattern: z.string().describe("Regular expression pattern."),
      replaceText: z.string().describe("Replacement text."),
      flags: z.string().optional().describe("Regex flags such as g, i, or m."),
    }),
  },
);

export const makeZipTool = tool(
  async ({ sourcePath, zipPath, overwrite }) => {
    try {
      const resolvedSourcePath = resolveToolPath(sourcePath);
      const resolvedZipPath = resolveToolPath(zipPath);
      assertNotProtectedPath(resolvedSourcePath);
      ensureWritableTarget(resolvedZipPath);

      if (!fs.existsSync(resolvedSourcePath)) {
        return `源路径不存在：${resolvedSourcePath}`;
      }

      if (fs.existsSync(resolvedZipPath)) {
        if (!overwrite) {
          return `ZIP 文件已存在：${resolvedZipPath}`;
        }
        fs.unlinkSync(resolvedZipPath);
      }

      const script = [
        "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        `Compress-Archive -LiteralPath '${resolvedSourcePath.replace(/'/g, "''")}' -DestinationPath '${resolvedZipPath.replace(/'/g, "''")}' -Force`,
      ].join(" ");

      await execFileUtf8("powershell.exe", ["-NoProfile", "-Command", script]);
      return `ZIP 创建成功：${resolvedZipPath}`;
    } catch (error) {
      return toToolError("创建 ZIP", error);
    }
  },
  {
    name: "make_zip",
    description:
      "Create a zip archive from a local file or directory. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      sourcePath: z.string().describe("Path of the file or directory to compress."),
      zipPath: z.string().describe("Destination path of the zip archive."),
      overwrite: z.boolean().optional().describe("Whether to overwrite an existing zip file."),
    }),
  },
);

export const openUrlTool = tool(
  async ({ url }) => {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return `不支持的 URL 协议：${parsed.protocol}`;
      }

      await shell.openExternal(parsed.toString());
      return `URL 打开成功：${parsed.toString()}`;
    } catch (error) {
      return toToolError("打开 URL", error);
    }
  },
  {
    name: "open_url",
    description: "Open an http or https URL in the system default browser.",
    schema: z.object({
      url: z.string().describe("HTTP or HTTPS URL to open."),
    }),
  },
);

export const extractZipTool = tool(
  async ({ zipPath, destinationPath, overwrite }) => {
    try {
      const resolvedZipPath = resolveToolPath(zipPath);
      const resolvedDestinationPath = resolveToolPath(destinationPath);
      assertNotProtectedPath(resolvedZipPath);
      ensureWritableTarget(path.join(resolvedDestinationPath, ".keep"));

      if (!fs.existsSync(resolvedZipPath)) {
        return `ZIP 文件不存在：${resolvedZipPath}`;
      }

      const stat = fs.statSync(resolvedZipPath);
      if (!stat.isFile()) {
        return `拒绝解压非文件路径：${resolvedZipPath}`;
      }

      if (fs.existsSync(resolvedDestinationPath)) {
        if (!overwrite) {
          return `目标路径已存在：${resolvedDestinationPath}`;
        }
        fs.rmSync(resolvedDestinationPath, { recursive: true, force: true });
      }

      fs.mkdirSync(resolvedDestinationPath, { recursive: true });

      const script = [
        "$OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
        `Expand-Archive -LiteralPath '${resolvedZipPath.replace(/'/g, "''")}' -DestinationPath '${resolvedDestinationPath.replace(/'/g, "''")}' -Force`,
      ].join(" ");

      await execFileUtf8("powershell.exe", ["-NoProfile", "-Command", script]);
      return `ZIP 解压成功：${resolvedDestinationPath}`;
    } catch (error) {
      return toToolError("解压 ZIP", error);
    }
  },
  {
    name: "extract_zip",
    description:
      "Extract a zip archive to a local directory. Parent directories are created automatically; protected system paths are refused.",
    schema: z.object({
      zipPath: z.string().describe("Path of the zip archive to extract."),
      destinationPath: z.string().describe("Destination directory for extracted files."),
      overwrite: z.boolean().optional().describe("Whether to overwrite the destination if it exists."),
    }),
  },
);

export const revealInFolderTool = tool(
  async ({ targetPath }) => {
    try {
      const resolvedPath = resolveToolPath(targetPath);
      assertNotProtectedPath(resolvedPath);

      if (!fs.existsSync(resolvedPath)) {
        return `路径不存在：${resolvedPath}`;
      }

      shell.showItemInFolder(resolvedPath);
      return `已在文件夹中定位：${resolvedPath}`;
    } catch (error) {
      return toToolError("在文件夹中显示", error);
    }
  },
  {
    name: "reveal_in_folder",
    description: "Reveal a local file or directory in the system file explorer.",
    schema: z.object({
      targetPath: z.string().describe("Path of the local file or directory to reveal."),
    }),
  },
);

export const openPathTool = tool(
  async ({ targetPath }) => {
    try {
      const resolvedPath = resolveToolPath(targetPath);
      assertNotProtectedPath(resolvedPath);

      if (!fs.existsSync(resolvedPath)) {
        return `路径不存在：${resolvedPath}`;
      }

      const result = await shell.openPath(resolvedPath);
      if (result) {
        return `打开路径失败：${result}`;
      }

      return `路径打开成功：${resolvedPath}`;
    } catch (error) {
      return toToolError("打开路径", error);
    }
  },
  {
    name: "open_path",
    description:
      "Open a local file or directory with the system default application or file explorer.",
    schema: z.object({
      targetPath: z.string().describe("Path of the local file or directory to open."),
    }),
  },
);

export const fileTools: DynamicStructuredTool[] = [
  readFileTool,
  writeFileTool,
  appendFileTool,
  createDirectoryTool,
  copyFileTool,
  listDirectoryTool,
  copyDirectoryTool,
  moveFileTool,
  moveDirectoryTool,
  deleteFileTool,
  searchFilesTool,
  searchFileContentTool,
  readJsonTool,
  writeJsonTool,
  fileExistsTool,
  pathStatTool,
  readCsvTool,
  insertIntoFileTool,
  replaceInFileTool,
  replaceRegexInFileTool,
  makeZipTool,
  openUrlTool,
  extractZipTool,
  revealInFolderTool,
  openPathTool,
];

export const allTools = fileTools;
