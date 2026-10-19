import { ipcMain, shell } from "electron";
import {
  fetchOllamaModels,
  applyModelSettings,
  getModelSettingsSnapshot,
  getChatModel,
  getAgentModel,
  getRagModel,
} from "../agent";
import { testOpenAICompatibleApi } from "../openaiCompatible";
import {
  listConversations,
  loadConversation,
  saveConversation,
  deleteConversation,
  updateConversationMeta,
  getActiveId,
  setActiveId,
  saveModelSettings,
  type ConvMeta,
  type StoredMessage,
  type ModelSettings,
  listAgentProfiles,
  saveAgentProfile,
  deleteAgentProfile,
  type AgentProfile,
  type OnlineProviderSettings,
} from "../storage";
import {
  createAndRunTask,
  listTasks,
  getTask,
  cancelTask,
  pauseTask,
  resumeTask,
  deleteTask,
  rerunTask,
  retryTaskSave,
} from "../taskRunner";

let modelSaveQueue: Promise<unknown> = Promise.resolve();

function persistModelConfig(patch: ModelSettings): Promise<ModelSettings> {
  const operation = modelSaveQueue.catch(() => undefined).then(async () => {
    const current = getModelSettingsSnapshot();
    const next = { ...current, ...patch, online: { ...current.online, ...patch.online } };
    await saveModelSettings(next);
    applyModelSettings(next);
    return getModelSettingsSnapshot();
  });
  modelSaveQueue = operation;
  return operation;
}

export function registerAppIpcHandlers(): void {
  ipcMain.handle("models:list", async () => {
    return fetchOllamaModels();
  });

  ipcMain.handle("settings:get-model-config", async () => {
    return getModelSettingsSnapshot();
  });

  ipcMain.handle(
    "settings:save-model-config",
    async (_event, settings: ModelSettings) => {
      return persistModelConfig(settings);
    },
  );

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

  ipcMain.handle("agents:list", () => {
    return listAgentProfiles();
  });

  ipcMain.handle("agents:save", (_event, agent: AgentProfile) => {
    const tools = agent?.tools;
    if (!tools || !Array.isArray(tools.enabledToolNames) ||
      tools.enabledToolNames.some(name => typeof name !== 'string') ||
      [tools.allowNetwork, tools.allowWrite, tools.allowDelete, tools.requireConfirmationForRisky].some(value => typeof value !== 'boolean')) {
      throw new Error('智能体工具权限格式无效，请重新打开编辑器。');
    }
    return saveAgentProfile(agent);
  });

  ipcMain.handle("agents:delete", (_event, id: string) => {
    return deleteAgentProfile(id);
  });

  ipcMain.handle("models:set", async (_event, modelName: string) => {
    const saved = await persistModelConfig({ chatModel: modelName });
    return saved.chatModel;
  });

  ipcMain.handle("models:set-chat", async (_event, modelName: string) => {
    const saved = await persistModelConfig({ chatModel: modelName });
    return saved.chatModel;
  });

  ipcMain.handle("models:get", async () => {
    return getChatModel();
  });

  ipcMain.handle("models:get-chat", async () => {
    return getChatModel();
  });

  ipcMain.handle("models:set-agent", async (_event, modelName: string) => {
    const saved = await persistModelConfig({ agentModel: modelName });
    return saved.agentModel;
  });

  ipcMain.handle("models:get-agent", async () => {
    return getAgentModel();
  });

  ipcMain.handle("models:set-rag", async (_event, modelName: string) => {
    const saved = await persistModelConfig({ ragModel: modelName });
    return saved.ragModel;
  });

  ipcMain.handle("models:get-rag", async () => {
    return getRagModel();
  });

  ipcMain.handle("storage:list", () => {
    return listConversations();
  });

  ipcMain.handle("storage:load", (_event, id: string) => {
    return loadConversation(id);
  });

  ipcMain.handle(
    "storage:save",
    async (_event, meta: ConvMeta, messages: StoredMessage[]) => {
      await saveConversation(meta, messages);
    },
  );

  ipcMain.handle("storage:update-meta", async (_event, meta: ConvMeta) => {
    await updateConversationMeta(meta);
  });

  ipcMain.handle("storage:delete", async (_event, id: string) => {
    await deleteConversation(id);
  });

  ipcMain.handle("storage:get-active", () => {
    return getActiveId();
  });

  ipcMain.handle("storage:set-active", async (_event, id: string | null) => {
    await setActiveId(id);
  });

  ipcMain.handle("task:create", (_event, prompt: string, agentProfileId?: string | null) => {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new Error('任务描述不能为空且不能超过 100000 字符。');
    if (agentProfileId != null && typeof agentProfileId !== 'string') throw new Error('智能体 ID 无效。');
    return createAndRunTask(prompt, agentProfileId);
  });

  ipcMain.handle("task:list", () => {
    return listTasks();
  });

  ipcMain.handle('task:retry-save', () => retryTaskSave());

  ipcMain.handle("task:get", (_event, id: string) => {
    return getTask(id) ?? null;
  });

  ipcMain.handle("task:cancel", (_event, id: string) => {
    return cancelTask(id);
  });

  ipcMain.handle("task:pause", (_event, id: string) => {
    return pauseTask(id);
  });

  ipcMain.handle("task:resume", (_event, id: string) => {
    return resumeTask(id);
  });

  ipcMain.handle("task:rerun", (_event, id: string) => {
    return rerunTask(id);
  });

  ipcMain.handle("task:delete", (_event, id: string) => {
    return deleteTask(id);
  });

  ipcMain.handle("shell:openPath", async (_event, filePath: string) => {
    const error = await shell.openPath(filePath);
    return error || null;
  });

  ipcMain.handle("shell:revealInFolder", async (_event, filePath: string) => {
    try {
      shell.showItemInFolder(filePath);
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });

  ipcMain.handle(
    "ui:perform-input-edit-action",
    (event, action: "copy" | "cut" | "paste") => {
      const webContents = event.sender;
      if (action === "copy") {
        webContents.copy();
        return;
      }
      if (action === "cut") {
        webContents.cut();
        return;
      }
      webContents.paste();
    },
  );
}
