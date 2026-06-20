import { ipcMain, shell } from "electron";
import {
  fetchOllamaModels,
  applyModelSettings,
  getModelSettingsSnapshot,
  setChatModel,
  getChatModel,
  setAgentModel,
  getAgentModel,
  setRagModel,
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
} from "../taskRunner";

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
      applyModelSettings(settings);
      const snapshot = getModelSettingsSnapshot();
      await saveModelSettings(snapshot);
      return snapshot;
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
    return saveAgentProfile(agent);
  });

  ipcMain.handle("agents:delete", (_event, id: string) => {
    return deleteAgentProfile(id);
  });

  ipcMain.handle("models:set", async (_event, modelName: string) => {
    setChatModel(modelName);
    await saveModelSettings({ chatModel: getChatModel() });
    return getChatModel();
  });

  ipcMain.handle("models:set-chat", async (_event, modelName: string) => {
    setChatModel(modelName);
    await saveModelSettings({ chatModel: getChatModel() });
    return getChatModel();
  });

  ipcMain.handle("models:get", async () => {
    return getChatModel();
  });

  ipcMain.handle("models:get-chat", async () => {
    return getChatModel();
  });

  ipcMain.handle("models:set-agent", async (_event, modelName: string) => {
    setAgentModel(modelName);
    await saveModelSettings({ agentModel: getAgentModel() });
    return getAgentModel();
  });

  ipcMain.handle("models:get-agent", async () => {
    return getAgentModel();
  });

  ipcMain.handle("models:set-rag", async (_event, modelName: string) => {
    setRagModel(modelName);
    await saveModelSettings({ ragModel: getRagModel() });
    return getRagModel();
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

  ipcMain.handle("task:create", (_event, prompt: string) => {
    return createAndRunTask(prompt);
  });

  ipcMain.handle("task:list", () => {
    return listTasks();
  });

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
