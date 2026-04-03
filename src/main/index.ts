import { app, shell, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";
import {
  chatWithAgent,
  chatStream,
  fetchOllamaModels,
  setModel,
  getModel,
  type ChatMessage,
} from "./agent";
import {
  listConversations,
  loadConversation,
  saveConversation,
  deleteConversation,
  updateConversationMeta,
  getActiveId,
  setActiveId,
  type ConvMeta,
  type StoredMessage,
} from "./storage";

// 当前请求的 AbortController 和 WebContents 引用
let currentAbortController: AbortController | null = null;
let currentWebContents: Electron.WebContents | null = null;

function shouldUseAgentTools(message: string): boolean {
  const text = message.toLowerCase();

  // 仅在明显需要工具时走 Agent，降低普通问答首字延迟。
  const toolIntentRegex =
    /(读取文件|读文件|写文件|删除文件|列出目录|搜索文件|当前时间|几点|计算|换算|单位|汇率|天气|联网|搜索|网页|链接|url|clipboard|copy|read file|write file|delete file|list directory|search files|time|calculate|calculator|unit convert|currency|weather|web search|fetch)/;

  return toolIntentRegex.test(text);
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#212121",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// IPC: 发送消息（流式）
ipcMain.handle(
  "chat:send",
  async (
    event,
    {
      history,
      message,
      useAgent,
    }: { history: ChatMessage[]; message: string; useAgent: boolean },
  ) => {
    const webContents = event.sender;

    // 中止上一次未完成的请求
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    currentWebContents = webContents;
    const { signal } = controller;

    try {
      const useTools = useAgent && shouldUseAgentTools(message);
      if (useTools) {
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
          signal,
        );
      } else {
        await chatStream(
          history,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal,
        );
      }
      webContents.send("chat:done");
    } catch (err: any) {
      // AbortError 不是错误，发送 done 以保留已输出内容
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
  },
);

// IPC: 中断当前请求
ipcMain.on("chat:abort", () => {
  // 立即通知渲染进程停止，不等待流真正取消
  if (currentWebContents && !currentWebContents.isDestroyed()) {
    currentWebContents.send("chat:done");
  }
  currentAbortController?.abort();
  currentAbortController = null;
  currentWebContents = null;
});

// IPC: 获取模型列表
ipcMain.handle("models:list", async () => {
  return fetchOllamaModels();
});

// IPC: 切换模型
ipcMain.handle("models:set", async (_event, modelName: string) => {
  setModel(modelName);
  return getModel();
});

// IPC: 获取当前模型
ipcMain.handle("models:get", async () => {
  return getModel();
});

// ---- 存储 IPC ----

// 获取对话列表（仅元数据）
ipcMain.handle("storage:list", () => {
  return listConversations();
});

// 加载单条对话的消息
ipcMain.handle("storage:load", (_event, id: string) => {
  return loadConversation(id);
});

// 保存单条对话（元数据 + 消息）
ipcMain.handle(
  "storage:save",
  (_event, meta: ConvMeta, messages: StoredMessage[]) => {
    saveConversation(meta, messages);
  },
);

// 仅更新元数据（标题、时间戳）
ipcMain.handle("storage:update-meta", (_event, meta: ConvMeta) => {
  updateConversationMeta(meta);
});

// 删除对话
ipcMain.handle("storage:delete", (_event, id: string) => {
  deleteConversation(id);
});

// 获取上次活跃 ID
ipcMain.handle("storage:get-active", () => {
  return getActiveId();
});

// 保存活跃 ID
ipcMain.handle("storage:set-active", (_event, id: string | null) => {
  setActiveId(id);
});

app.whenReady().then(() => {
  createWindow();

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
