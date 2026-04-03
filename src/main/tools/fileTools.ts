import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// 读取文件工具
export const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      return `文件读取成功 (${lines} 行):\n\`\`\`\n${content}\n\`\`\``;
    } catch (e: any) {
      return `读取文件失败: ${e.message}`;
    }
  },
  {
    name: "read_file",
    description: "读取本地文件内容。输入文件的绝对路径或相对路径。",
    schema: z.object({
      filePath: z.string().describe("要读取的文件路径"),
    }),
  },
);

// 写入文件工具
export const writeFileTool = tool(
  async ({ filePath, content }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(resolvedPath, content, "utf-8");
      return `文件写入成功: ${resolvedPath}`;
    } catch (e: any) {
      return `写入文件失败: ${e.message}`;
    }
  },
  {
    name: "write_file",
    description: "将内容写入本地文件。如果目录不存在会自动创建。",
    schema: z.object({
      filePath: z.string().describe("要写入的文件路径"),
      content: z.string().describe("要写入的内容"),
    }),
  },
);

// 列出目录工具
export const listDirectoryTool = tool(
  async ({ dirPath }) => {
    try {
      const resolvedPath = path.resolve(dirPath);
      const entries = fs.readdirSync(resolvedPath, { withFileTypes: true });
      const result = entries.map((entry) => {
        const type = entry.isDirectory() ? "[目录]" : "[文件]";
        const size = entry.isFile()
          ? ` (${fs.statSync(path.join(resolvedPath, entry.name)).size} bytes)`
          : "";
        return `${type} ${entry.name}${size}`;
      });
      return `目录 "${resolvedPath}" 的内容:\n${result.join("\n")}`;
    } catch (e: any) {
      return `列出目录失败: ${e.message}`;
    }
  },
  {
    name: "list_directory",
    description: "列出指定目录下的所有文件和子目录。",
    schema: z.object({
      dirPath: z.string().describe("要列出内容的目录路径"),
    }),
  },
);

// 删除文件工具
export const deleteFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path.resolve(filePath);
      if (!fs.existsSync(resolvedPath)) {
        return `文件不存在: ${resolvedPath}`;
      }
      fs.unlinkSync(resolvedPath);
      return `文件删除成功: ${resolvedPath}`;
    } catch (e: any) {
      return `删除文件失败: ${e.message}`;
    }
  },
  {
    name: "delete_file",
    description: "删除指定路径的文件。",
    schema: z.object({
      filePath: z.string().describe("要删除的文件路径"),
    }),
  },
);

// 搜索文件工具
export const searchFilesTool = tool(
  async ({ dirPath, keyword }) => {
    try {
      const resolvedPath = path.resolve(dirPath);
      const results: string[] = [];

      const searchDir = (dir: string): void => {
        if (results.length >= 50) return;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (
                !entry.name.startsWith(".") &&
                entry.name !== "node_modules"
              ) {
                searchDir(fullPath);
              }
            } else if (
              entry.name.toLowerCase().includes(keyword.toLowerCase())
            ) {
              results.push(fullPath);
            }
          }
        } catch {
          // 忽略无权限目录
        }
      };

      searchDir(resolvedPath);
      if (results.length === 0)
        return `在 "${resolvedPath}" 中未找到包含 "${keyword}" 的文件`;
      return `找到 ${results.length} 个文件:\n${results.join("\n")}`;
    } catch (e: any) {
      return `搜索失败: ${e.message}`;
    }
  },
  {
    name: "search_files",
    description: "在指定目录中按文件名关键词搜索文件。",
    schema: z.object({
      dirPath: z.string().describe("要搜索的目录路径"),
      keyword: z.string().describe("文件名中要搜索的关键词"),
    }),
  },
);

export const fileTools: DynamicStructuredTool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool,
];

export const allTools = fileTools;
