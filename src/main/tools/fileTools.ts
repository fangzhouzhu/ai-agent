import { shell } from "electron";
import { tool, type DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
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
  return `${action} failed: ${message}`;
}

export const readFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertReadableFile(resolvedPath);
      const content = fs.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      return `File read successfully (${lines} lines):\n\`\`\`\n${content}\n\`\`\``;
    } catch (error) {
      return toToolError("Read file", error);
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
      return `File written successfully: ${resolvedPath}`;
    } catch (error) {
      return toToolError("Write file", error);
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
        entries.length > result.length ? `\n... ${entries.length - result.length} more entries omitted` : "";
      return `Directory "${resolvedPath}" contents:\n${result.join("\n")}${truncated}`;
    } catch (error) {
      return toToolError("List directory", error);
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

export const deleteFileTool = tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = resolveToolPath(filePath);
      assertNotProtectedPath(resolvedPath);
      if (!fs.existsSync(resolvedPath)) {
        return `File does not exist: ${resolvedPath}`;
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        return `Refusing to delete non-file path: ${resolvedPath}`;
      }
      await shell.trashItem(resolvedPath);
      return `File moved to system trash: ${resolvedPath}`;
    } catch (error) {
      return toToolError("Delete file", error);
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
        return `No files containing "${keyword}" were found in "${resolvedPath}".`;
      }
      return `Found ${results.length} files:\n${results.join("\n")}`;
    } catch (error) {
      return toToolError("Search files", error);
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

export const fileTools: DynamicStructuredTool[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool,
];

export const allTools = fileTools;
