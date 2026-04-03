import { contextBridge, ipcRenderer } from "electron";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ConvMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  isError?: boolean;
};

const api = {
  // 发送聊天消息
  sendMessage: (history: ChatMessage[], message: string, useAgent: boolean) =>
    ipcRenderer.invoke("chat:send", { history, message, useAgent }),

  // 流式 token
  onToken: (callback: (token: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, token: string) =>
      callback(token);
    ipcRenderer.on("chat:token", handler);
    return () => ipcRenderer.removeListener("chat:token", handler);
  },

  // 工具调用通知
  onToolCall: (
    callback: (data: { toolName: string; input: unknown }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { toolName: string; input: unknown },
    ) => callback(data);
    ipcRenderer.on("chat:tool-call", handler);
    return () => ipcRenderer.removeListener("chat:tool-call", handler);
  },

  // 工具结果通知
  onToolResult: (
    callback: (data: { toolName: string; result: string }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { toolName: string; result: string },
    ) => callback(data);
    ipcRenderer.on("chat:tool-result", handler);
    return () => ipcRenderer.removeListener("chat:tool-result", handler);
  },

  // 完成通知
  onDone: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on("chat:done", handler);
    return () => ipcRenderer.removeListener("chat:done", handler);
  },

  // 错误通知
  onError: (callback: (err: string) => void) => {
    const handler = (_: Electron.IpcRendererEvent, err: string) =>
      callback(err);
    ipcRenderer.on("chat:error", handler);
    return () => ipcRenderer.removeListener("chat:error", handler);
  },

  // 模型相关
  listModels: () => ipcRenderer.invoke("models:list"),
  setModel: (modelName: string) => ipcRenderer.invoke("models:set", modelName),
  getModel: () => ipcRenderer.invoke("models:get"),

  // 中断当前请求
  abortChat: () => ipcRenderer.send("chat:abort"),

  // ---- 存储 API ----
  storage: {
    // 获取所有对话元数据列表（轻量，用于侧边栏）
    list: (): Promise<ConvMeta[]> => ipcRenderer.invoke("storage:list"),

    // 加载某条对话的消息（按需）
    load: (id: string): Promise<StoredMessage[]> =>
      ipcRenderer.invoke("storage:load", id),

    // 保存整条对话（元数据 + 消息）
    save: (meta: ConvMeta, messages: StoredMessage[]): Promise<void> =>
      ipcRenderer.invoke("storage:save", meta, messages),

    // 只更新元数据（标题、时间戳）
    updateMeta: (meta: ConvMeta): Promise<void> =>
      ipcRenderer.invoke("storage:update-meta", meta),

    // 删除对话
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke("storage:delete", id),

    // 活跃 ID
    getActive: (): Promise<string | null> =>
      ipcRenderer.invoke("storage:get-active"),
    setActive: (id: string | null): Promise<void> =>
      ipcRenderer.invoke("storage:set-active", id),
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
