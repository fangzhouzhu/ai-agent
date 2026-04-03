"use strict";
const electron = require("electron");
const path = require("path");
const utils = require("@electron-toolkit/utils");
const ollama = require("@langchain/ollama");
const messages = require("@langchain/core/messages");
const tools = require("@langchain/core/tools");
const zod = require("zod");
const fs = require("fs");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const path__namespace = /* @__PURE__ */ _interopNamespaceDefault(path);
const fs__namespace = /* @__PURE__ */ _interopNamespaceDefault(fs);
const readFileTool = tools.tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      const content = fs__namespace.readFileSync(resolvedPath, "utf-8");
      const lines = content.split("\n").length;
      return `文件读取成功 (${lines} 行):
\`\`\`
${content}
\`\`\``;
    } catch (e) {
      return `读取文件失败: ${e.message}`;
    }
  },
  {
    name: "read_file",
    description: "读取本地文件内容。输入文件的绝对路径或相对路径。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要读取的文件路径")
    })
  }
);
const writeFileTool = tools.tool(
  async ({ filePath, content }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      const dir = path__namespace.dirname(resolvedPath);
      if (!fs__namespace.existsSync(dir)) {
        fs__namespace.mkdirSync(dir, { recursive: true });
      }
      fs__namespace.writeFileSync(resolvedPath, content, "utf-8");
      return `文件写入成功: ${resolvedPath}`;
    } catch (e) {
      return `写入文件失败: ${e.message}`;
    }
  },
  {
    name: "write_file",
    description: "将内容写入本地文件。如果目录不存在会自动创建。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要写入的文件路径"),
      content: zod.z.string().describe("要写入的内容")
    })
  }
);
const listDirectoryTool = tools.tool(
  async ({ dirPath }) => {
    try {
      const resolvedPath = path__namespace.resolve(dirPath);
      const entries = fs__namespace.readdirSync(resolvedPath, { withFileTypes: true });
      const result = entries.map((entry) => {
        const type = entry.isDirectory() ? "[目录]" : "[文件]";
        const size = entry.isFile() ? ` (${fs__namespace.statSync(path__namespace.join(resolvedPath, entry.name)).size} bytes)` : "";
        return `${type} ${entry.name}${size}`;
      });
      return `目录 "${resolvedPath}" 的内容:
${result.join("\n")}`;
    } catch (e) {
      return `列出目录失败: ${e.message}`;
    }
  },
  {
    name: "list_directory",
    description: "列出指定目录下的所有文件和子目录。",
    schema: zod.z.object({
      dirPath: zod.z.string().describe("要列出内容的目录路径")
    })
  }
);
const deleteFileTool = tools.tool(
  async ({ filePath }) => {
    try {
      const resolvedPath = path__namespace.resolve(filePath);
      if (!fs__namespace.existsSync(resolvedPath)) {
        return `文件不存在: ${resolvedPath}`;
      }
      fs__namespace.unlinkSync(resolvedPath);
      return `文件删除成功: ${resolvedPath}`;
    } catch (e) {
      return `删除文件失败: ${e.message}`;
    }
  },
  {
    name: "delete_file",
    description: "删除指定路径的文件。",
    schema: zod.z.object({
      filePath: zod.z.string().describe("要删除的文件路径")
    })
  }
);
const searchFilesTool = tools.tool(
  async ({ dirPath, keyword }) => {
    try {
      const resolvedPath = path__namespace.resolve(dirPath);
      const results = [];
      const searchDir = (dir) => {
        if (results.length >= 50) return;
        try {
          const entries = fs__namespace.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path__namespace.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (!entry.name.startsWith(".") && entry.name !== "node_modules") {
                searchDir(fullPath);
              }
            } else if (entry.name.toLowerCase().includes(keyword.toLowerCase())) {
              results.push(fullPath);
            }
          }
        } catch {
        }
      };
      searchDir(resolvedPath);
      if (results.length === 0)
        return `在 "${resolvedPath}" 中未找到包含 "${keyword}" 的文件`;
      return `找到 ${results.length} 个文件:
${results.join("\n")}`;
    } catch (e) {
      return `搜索失败: ${e.message}`;
    }
  },
  {
    name: "search_files",
    description: "在指定目录中按文件名关键词搜索文件。",
    schema: zod.z.object({
      dirPath: zod.z.string().describe("要搜索的目录路径"),
      keyword: zod.z.string().describe("文件名中要搜索的关键词")
    })
  }
);
const allTools = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  deleteFileTool,
  searchFilesTool
];
let currentModel = "qcwind/qwen2.5-7B-instruct-Q4_K_M";
function setModel(modelName) {
  currentModel = modelName;
}
function getModel() {
  return currentModel;
}
function buildLLM(streaming = false) {
  return new ollama.ChatOllama({
    model: currentModel,
    baseUrl: "http://localhost:11434",
    streaming
    // verbose: true, // 在主进程终端打印请求/响应详情
  });
}
async function fetchOllamaModels() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) return [];
    const data = await res.json();
    return data.models.map((m) => m.name);
  } catch {
    return [];
  }
}
function toLC(msg) {
  if (msg.role === "user") return new messages.HumanMessage(msg.content);
  if (msg.role === "assistant") return new messages.AIMessage(msg.content);
  return new messages.SystemMessage(msg.content);
}
const SYSTEM_PROMPT = `你是一个智能助手，可以帮助用户对话、分析问题，以及操作本地文件系统。
你拥有以下工具：
- read_file: 读取文件内容
- write_file: 写入文件
- list_directory: 列出目录内容
- delete_file: 删除文件
- search_files: 按文件名搜索文件

当用户需要操作文件时，优先使用对应的工具。回答尽量简洁清晰，使用 Markdown 格式。`;
async function chatWithAgent(history, userMessage, onToken, onToolCall, onToolResult, signal) {
  const llm = buildLLM(false);
  const llmWithTools = llm.bindTools(allTools);
  const messages$1 = [
    new messages.SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  let fullResponse = "";
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted();
    const response = await llmWithTools.invoke(messages$1, { signal });
    if (response.tool_calls && response.tool_calls.length > 0) {
      messages$1.push(response);
      for (const toolCall of response.tool_calls) {
        signal?.throwIfAborted();
        const tool = allTools.find((t) => t.name === toolCall.name);
        if (!tool) continue;
        onToolCall(toolCall.name, toolCall.args);
        const result = await tool.invoke(toolCall.args);
        const resultStr = String(result);
        onToolResult(toolCall.name, resultStr);
        messages$1.push({
          role: "tool",
          content: resultStr,
          tool_call_id: toolCall.id ?? ""
        });
      }
    } else {
      const streamingLLM = buildLLM(true);
      const streamMessages = messages$1.concat([]);
      const stream = await streamingLLM.stream(streamMessages, { signal });
      for await (const chunk of stream) {
        signal?.throwIfAborted();
        const token = typeof chunk.content === "string" ? chunk.content : "";
        if (token) {
          onToken(token);
          fullResponse += token;
        }
      }
      break;
    }
  }
  return fullResponse;
}
async function chatStream(history, userMessage, onToken, signal) {
  const llm = buildLLM(true);
  const messages$1 = [
    new messages.SystemMessage(SYSTEM_PROMPT),
    ...history.map(toLC),
    new messages.HumanMessage(userMessage)
  ];
  let fullResponse = "";
  const stream = await llm.stream(messages$1, { signal });
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    const token = typeof chunk.content === "string" ? chunk.content : "";
    if (token) {
      onToken(token);
      fullResponse += token;
    }
  }
  return fullResponse;
}
function getDataDir() {
  const dir = path.join(electron.app.getPath("userData"), "ai-agent");
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  return dir;
}
function getConvDir() {
  const dir = path.join(getDataDir(), "conversations");
  if (!fs__namespace.existsSync(dir)) fs__namespace.mkdirSync(dir, { recursive: true });
  return dir;
}
const INDEX_FILE = () => path.join(getDataDir(), "index.json");
const ACTIVE_FILE = () => path.join(getDataDir(), "active.json");
function readJSON(filePath, fallback) {
  try {
    if (!fs__namespace.existsSync(filePath)) return fallback;
    return JSON.parse(fs__namespace.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}
function writeJSON(filePath, data) {
  fs__namespace.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
function listConversations() {
  return readJSON(INDEX_FILE(), []).sort(
    (a, b) => b.updatedAt - a.updatedAt
  );
}
function saveIndex(metas) {
  writeJSON(INDEX_FILE(), metas);
}
function loadConversation(id) {
  const file = path.join(getConvDir(), `${id}.json`);
  return readJSON(file, []);
}
function saveConversation(meta, messages2) {
  const metas = readJSON(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
  } else {
    metas.unshift(meta);
  }
  saveIndex(metas);
  const file = path.join(getConvDir(), `${meta.id}.json`);
  writeJSON(file, messages2);
}
function deleteConversation(id) {
  const metas = readJSON(INDEX_FILE(), []);
  saveIndex(metas.filter((m) => m.id !== id));
  const file = path.join(getConvDir(), `${id}.json`);
  if (fs__namespace.existsSync(file)) fs__namespace.unlinkSync(file);
}
function updateConversationMeta(meta) {
  const metas = readJSON(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
    saveIndex(metas);
  }
}
function getActiveId() {
  return readJSON(ACTIVE_FILE(), { id: null }).id;
}
function setActiveId(id) {
  writeJSON(ACTIVE_FILE(), { id });
}
let currentAbortController = null;
let currentWebContents = null;
function createWindow() {
  const mainWindow = new electron.BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#212121",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    electron.shell.openExternal(details.url);
    return { action: "deny" };
  });
  if (utils.is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}
electron.ipcMain.handle(
  "chat:send",
  async (event, {
    history,
    message,
    useAgent
  }) => {
    const webContents = event.sender;
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    currentWebContents = webContents;
    const { signal } = controller;
    try {
      if (useAgent) {
        await chatWithAgent(
          history,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          (toolName, input) => {
            webContents.send("chat:tool-call", { toolName, input });
          },
          (toolName, result) => {
            webContents.send("chat:tool-result", { toolName, result });
          },
          signal
        );
      } else {
        await chatStream(
          history,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal
        );
      }
      webContents.send("chat:done");
    } catch (err) {
      if (err?.name === "AbortError" || signal.aborted) {
        webContents.send("chat:done");
      } else {
        webContents.send("chat:error", err.message || "未知错误");
      }
    } finally {
      if (currentAbortController === controller) {
        currentAbortController = null;
        currentWebContents = null;
      }
    }
  }
);
electron.ipcMain.on("chat:abort", () => {
  if (currentWebContents && !currentWebContents.isDestroyed()) {
    currentWebContents.send("chat:done");
  }
  currentAbortController?.abort();
  currentAbortController = null;
  currentWebContents = null;
});
electron.ipcMain.handle("models:list", async () => {
  return fetchOllamaModels();
});
electron.ipcMain.handle("models:set", async (_event, modelName) => {
  setModel(modelName);
  return getModel();
});
electron.ipcMain.handle("models:get", async () => {
  return getModel();
});
electron.ipcMain.handle("storage:list", () => {
  return listConversations();
});
electron.ipcMain.handle("storage:load", (_event, id) => {
  return loadConversation(id);
});
electron.ipcMain.handle(
  "storage:save",
  (_event, meta, messages2) => {
    saveConversation(meta, messages2);
  }
);
electron.ipcMain.handle("storage:update-meta", (_event, meta) => {
  updateConversationMeta(meta);
});
electron.ipcMain.handle("storage:delete", (_event, id) => {
  deleteConversation(id);
});
electron.ipcMain.handle("storage:get-active", () => {
  return getActiveId();
});
electron.ipcMain.handle("storage:set-active", (_event, id) => {
  setActiveId(id);
});
electron.app.whenReady().then(() => {
  createWindow();
  electron.app.on("activate", function() {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    electron.app.quit();
  }
});
console.log("主进程已启动");
//# sourceMappingURL=index.js.map
