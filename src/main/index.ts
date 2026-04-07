import { app, shell, BrowserWindow, ipcMain, dialog } from "electron";
import { basename, join } from "path";
import { is } from "@electron-toolkit/utils";
import {
  chatWithAgent,
  chatStream,
  chatWithRag,
  fetchOllamaModels,
  setChatModel,
  getChatModel,
  setAgentModel,
  getAgentModel,
  setRagModel,
  getRagModel,
  applyModelSettings,
  getModelSettingsSnapshot,
  getChatProvider,
  getAgentProvider,
  describeRouteModel,
  type ChatMessage,
} from "./agent";
import { testOpenAICompatibleApi } from "./openaiCompatible";
import { ingestFile, listRagFiles, removeRagFile } from "./rag";
import { matchSkillForInput } from "./skills";
import {
  listConversations,
  loadConversation,
  saveConversation,
  deleteConversation,
  updateConversationMeta,
  getActiveId,
  setActiveId,
  getModelSettings,
  saveModelSettings,
  getSkills,
  saveSkills,
  type ConvMeta,
  type StoredMessage,
  type ModelSettings,
  type OnlineProviderSettings,
  type SkillConfig,
} from "./storage";

// 当前请求的 AbortController 和 WebContents 引用
let currentAbortController: AbortController | null = null;
let currentWebContents: Electron.WebContents | null = null;

function shouldUseAgentTools(message: string): boolean {
  const text = message.toLowerCase();

  // 仅在明显需要工具时走 Agent，降低普通问答首字延迟。
  const toolIntentRegex =
    /(读取文件|读文件|写文件|删除文件|列出目录|搜索文件|当前时间|当前日期|今天几号|今天是几号|今天几月几号|今天星期几|今天周几|今天是哪天|几号|几月几号|星期几|周几|日期|几点|计算|换算|单位|汇率|天气|联网|搜索|网页|链接|url|clipboard|copy|read file|write file|delete file|list directory|search files|time|date|today|day of week|calculate|calculator|unit convert|currency|weather|web search|fetch)/;

  return toolIntentRegex.test(text);
}

function shouldUseRealtimeTool(message: string): boolean {
  const text = message.toLowerCase();
  const realtimeIntentRegex =
    /(今天|现在|当前|今日).*(日期|时间|几点|几号|星期几|周几|哪天)|((what|which)\s+day\s+is\s+it)|(today'?s?\s+date)|current\s+(date|time)/;

  return realtimeIntentRegex.test(text);
}

function shouldUseAdvancedModel(message: string): boolean {
  const text = message.toLowerCase();
  const advancedIntentRegex =
    /(代码|编程|函数|组件|报错|错误|bug|调试|修复|重构|优化|架构|设计|分析|方案|总结|脚本|sql|正则|code|debug|fix|refactor|optimi[sz]e|architecture|analy[sz]e|plan)/;

  return (
    advancedIntentRegex.test(text) || message.length > 120 || /\n/.test(message)
  );
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
      fileIds,
    }: {
      history: ChatMessage[];
      message: string;
      useAgent: boolean;
      fileIds?: string[];
    },
  ) => {
    const webContents = event.sender;

    // 中止上一次未完成的请求
    currentAbortController?.abort();
    const controller = new AbortController();
    currentAbortController = controller;
    currentWebContents = webContents;
    const { signal } = controller;

    try {
      const useRag = Array.isArray(fileIds) && fileIds.length > 0;
      const matchedSkill = matchSkillForInput(message, getSkills());
      const preferredScene = matchedSkill?.skill.preferredScene ?? "auto";
      const useRealtimeTool = !useRag && shouldUseRealtimeTool(message);

      let useTools =
        !useRag &&
        (useRealtimeTool || (useAgent && shouldUseAgentTools(message)));
      let useAdvancedModel =
        !useRag && (useTools || shouldUseAdvancedModel(message));

      if (!useRag && preferredScene === "chat" && !useRealtimeTool) {
        useTools = false;
        useAdvancedModel = false;
      } else if (!useRag && preferredScene === "agent") {
        useTools = true;
        useAdvancedModel = true;
      }

      const effectiveHistory = useRealtimeTool ? [] : history;

      const modelInfo = useRag
        ? {
            model: describeRouteModel("rag"),
            scene: "RAG",
            skill: matchedSkill?.skill.name,
          }
        : useTools
          ? {
              model: describeRouteModel("agent"),
              scene: "Agent/工具",
              skill: matchedSkill?.skill.name,
            }
          : useAdvancedModel
            ? {
                model: describeRouteModel("agent"),
                scene: "复杂任务",
                skill: matchedSkill?.skill.name,
              }
            : {
                model: describeRouteModel("chat"),
                scene: "普通对话",
                skill: matchedSkill?.skill.name,
              };

      webContents.send("chat:model-info", modelInfo);

      // 自动路由：文档问答 -> RAG 模型；工具/复杂任务 -> Agent 模型；其余 -> 普通对话模型
      if (useRag) {
        await chatWithRag(
          effectiveHistory,
          message,
          fileIds,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal,
          matchedSkill?.skill,
        );
      } else if (useTools) {
        await chatWithAgent(
          effectiveHistory,
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
          matchedSkill?.skill,
        );
      } else {
        await chatStream(
          effectiveHistory,
          message,
          (token) => {
            webContents.send("chat:token", token);
          },
          signal,
          useAdvancedModel ? getAgentModel() : getChatModel(),
          useAdvancedModel ? getAgentProvider() : getChatProvider(),
          matchedSkill?.skill,
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

// IPC: 获取完整模型/Provider 配置
ipcMain.handle("settings:get-model-config", async () => {
  return getModelSettingsSnapshot();
});

// IPC: 保存完整模型/Provider 配置
ipcMain.handle(
  "settings:save-model-config",
  async (_event, settings: ModelSettings) => {
    applyModelSettings(settings);
    const snapshot = getModelSettingsSnapshot();
    saveModelSettings(snapshot);
    return snapshot;
  },
);

// IPC: 测试在线 API 是否可用
ipcMain.handle(
  "settings:test-online",
  async (
    _event,
    payload: { online: OnlineProviderSettings; model?: string },
  ) => {
    return testOpenAICompatibleApi({
      settings: payload.online,
      model: payload.model,
    });
  },
);

// IPC: 本地 Skills 配置
ipcMain.handle("skills:list", async () => {
  return getSkills();
});

ipcMain.handle("skills:save", async (_event, skills: SkillConfig[]) => {
  saveSkills(skills);
  return getSkills();
});

// IPC: 选择并上传文档到 RAG 索引
ipcMain.handle("rag:pick-files", async (event) => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Documents",
        extensions: ["txt", "md", "pdf", "docx", "csv", "json", "ts", "js"],
      },
      { name: "All Files", extensions: ["*"] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) {
    event.sender.send("rag:status", { status: "idle", message: "" });
    return [];
  }

  const total = result.filePaths.length;
  const uploaded = [];

  try {
    event.sender.send("rag:status", {
      status: "processing",
      current: 0,
      total,
      message:
        total > 1
          ? `已选择 ${total} 个文件，正在依次解析并建立索引...`
          : "文件已选择，正在解析并建立索引...",
    });

    for (let i = 0; i < total; i++) {
      const filePath = result.filePaths[i];
      event.sender.send("rag:status", {
        status: "processing",
        current: i + 1,
        total,
        fileName: basename(filePath),
        message: `正在分析 ${basename(filePath)}（${i + 1}/${total}）...`,
      });
      uploaded.push(await ingestFile(filePath));
    }

    event.sender.send("rag:status", {
      status: "completed",
      current: total,
      total,
      message:
        total > 1
          ? `已完成 ${total} 个文件的分析，现在可以开始提问。`
          : "文件分析完成，现在可以开始提问。",
    });

    return uploaded;
  } catch (error: any) {
    event.sender.send("rag:status", {
      status: "error",
      current: uploaded.length,
      total,
      message: error?.message || "文档分析失败，请稍后重试。",
    });
    throw new Error(
      error?.message ||
        "文档解析或向量化失败，请确认 Ollama 已安装并可用 `nomic-embed-text` 模型。",
    );
  }
});

// IPC: 查询当前已上传文档
ipcMain.handle("rag:list", () => {
  return listRagFiles();
});

// IPC: 删除单个已上传文档
ipcMain.handle("rag:remove", (_event, id: string) => {
  return removeRagFile(id);
});

// IPC: 切换聊天模型
ipcMain.handle("models:set", async (_event, modelName: string) => {
  setChatModel(modelName);
  saveModelSettings({ chatModel: getChatModel() });
  return getChatModel();
});

ipcMain.handle("models:set-chat", async (_event, modelName: string) => {
  setChatModel(modelName);
  saveModelSettings({ chatModel: getChatModel() });
  return getChatModel();
});

// IPC: 获取当前聊天模型
ipcMain.handle("models:get", async () => {
  return getChatModel();
});

ipcMain.handle("models:get-chat", async () => {
  return getChatModel();
});

// IPC: 切换 Agent / 工具模型
ipcMain.handle("models:set-agent", async (_event, modelName: string) => {
  setAgentModel(modelName);
  saveModelSettings({ agentModel: getAgentModel() });
  return getAgentModel();
});

// IPC: 获取当前 Agent / 工具模型
ipcMain.handle("models:get-agent", async () => {
  return getAgentModel();
});

// IPC: 切换 RAG 回答模型
ipcMain.handle("models:set-rag", async (_event, modelName: string) => {
  setRagModel(modelName);
  saveModelSettings({ ragModel: getRagModel() });
  return getRagModel();
});

// IPC: 获取当前 RAG 回答模型
ipcMain.handle("models:get-rag", async () => {
  return getRagModel();
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

app.whenReady().then(async () => {
  // 启动时先恢复用户配置，再根据本地可用模型自动补齐缺失项
  const savedSettings = getModelSettings();
  applyModelSettings(savedSettings);

  await fetchOllamaModels();
  saveModelSettings(getModelSettingsSnapshot());

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
