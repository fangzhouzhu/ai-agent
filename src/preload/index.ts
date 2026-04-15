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
  modelInfo?: { model: string; scene: string };
  ragContextId?: string;
  isError?: boolean;
};

export type ModelRouteInfo = {
  model: string;
  scene: string;
  skill?: string;
};

export type RagFileMeta = {
  id: string;
  name: string;
  path: string;
  chunks: number;
  uploadedAt: number;
};

export type RagStatus = {
  status: "idle" | "processing" | "completed" | "error";
  message: string;
  current?: number;
  total?: number;
  fileName?: string;
};

export type KnowledgeBase = {
  id: string;
  name: string;
  description: string;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  docCount: number;
  chunkCount: number;
  createdAt: number;
  updatedAt: number;
};

export type KbDocStatus =
  | "pending"
  | "parsing"
  | "chunking"
  | "embedding"
  | "ready"
  | "failed";

export type KbDocument = {
  id: string;
  knowledgeBaseId: string;
  fileName: string;
  originalPath: string;
  storedPath: string;
  hash: string;
  size: number;
  status: KbDocStatus;
  chunkCount: number;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

export type KbIndexingProgress = {
  docId: string;
  kbId: string;
  status: string;
  message: string;
  progress?: number;
};

export type TaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type TaskStep = {
  id: string;
  type: "plan" | "tool_call" | "tool_result" | "thinking" | "output" | "error";
  label: string;
  content: string;
  timestamp: number;
};

export type Task = {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  steps: TaskStep[];
  result: string;
  outputFiles: string[];
  createdAt: number;
  updatedAt: number;
};

export type ModelProvider = "ollama" | "openai-compatible";
export type SkillPreferredScene = "auto" | "chat" | "agent" | "rag";

export type SkillConfig = {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  systemPrompt: string;
  enabled: boolean;
  preferredScene: SkillPreferredScene;
  priority: number;
  createdAt: number;
  updatedAt: number;
};

export type RouteModelSetting = {
  provider: ModelProvider;
  model: string;
};

export type OnlineProviderSettings = {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
};

export type OnlineProviderProfile = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  chatModel?: string;
  agentModel?: string;
  ragModel?: string;
  createdAt: number;
  updatedAt: number;
};

export type FullModelConfig = {
  chatModel?: string;
  agentModel?: string;
  ragModel?: string;
  chatProvider?: ModelProvider;
  agentProvider?: ModelProvider;
  ragProvider?: ModelProvider;
  online?: OnlineProviderSettings;
  onlineProfiles?: OnlineProviderProfile[];
  activeOnlineProfileId?: string | null;
};

export type OnlineApiTestResult = {
  ok: boolean;
  message: string;
  models: string[];
  latencyMs?: number;
  balanceInfo?: string;
  testedAt?: number;
};

const api = {
  // 发送聊天消息
  sendMessage: (
    history: ChatMessage[],
    message: string,
    useAgent: boolean,
    fileIds: string[] = [],
    kbIds: string[] = [],
  ) =>
    ipcRenderer.invoke("chat:send", {
      history,
      message,
      useAgent,
      fileIds,
      kbIds,
    }),

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

  // 当前回复所用模型与路由场景
  onModelInfo: (callback: (data: ModelRouteInfo) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ModelRouteInfo) =>
      callback(data);
    ipcRenderer.on("chat:model-info", handler);
    return () => ipcRenderer.removeListener("chat:model-info", handler);
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
  setChatModel: (modelName: string) =>
    ipcRenderer.invoke("models:set-chat", modelName),
  getChatModel: () => ipcRenderer.invoke("models:get-chat"),
  setAgentModel: (modelName: string) =>
    ipcRenderer.invoke("models:set-agent", modelName),
  getAgentModel: () => ipcRenderer.invoke("models:get-agent"),
  setRagModel: (modelName: string) =>
    ipcRenderer.invoke("models:set-rag", modelName),
  getRagModel: () => ipcRenderer.invoke("models:get-rag"),
  getModelConfig: (): Promise<FullModelConfig> =>
    ipcRenderer.invoke("settings:get-model-config"),
  saveModelConfig: (config: FullModelConfig): Promise<FullModelConfig> =>
    ipcRenderer.invoke("settings:save-model-config", config),
  testOnlineApi: (
    online: OnlineProviderSettings,
    model?: string,
  ): Promise<OnlineApiTestResult> =>
    ipcRenderer.invoke("settings:test-online", { online, model }),

  // 本地 Skills
  listSkills: (): Promise<SkillConfig[]> => ipcRenderer.invoke("skills:list"),
  saveSkills: (skills: SkillConfig[]): Promise<SkillConfig[]> =>
    ipcRenderer.invoke("skills:save", skills),

  // 中断当前请求
  abortChat: () => ipcRenderer.send("chat:abort"),

  // ---- RAG API ----
  rag: {
    pickFiles: (): Promise<RagFileMeta[]> =>
      ipcRenderer.invoke("rag:pick-files"),
    list: (): Promise<RagFileMeta[]> => ipcRenderer.invoke("rag:list"),
    remove: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("rag:remove", id),
    onStatus: (callback: (data: RagStatus) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: RagStatus) =>
        callback(data);
      ipcRenderer.on("rag:status", handler);
      return () => ipcRenderer.removeListener("rag:status", handler);
    },
  },

  // ---- 知识库 API ----
  kb: {
    list: (): Promise<KnowledgeBase[]> => ipcRenderer.invoke("kb:list"),
    create: (data: {
      name: string;
      description?: string;
      chunkSize?: number;
      chunkOverlap?: number;
    }): Promise<KnowledgeBase> => ipcRenderer.invoke("kb:create", data),
    update: (
      id: string,
      data: { name?: string; description?: string },
    ): Promise<KnowledgeBase | null> =>
      ipcRenderer.invoke("kb:update", id, data),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("kb:delete", id),
    listDocs: (kbId: string): Promise<KbDocument[]> =>
      ipcRenderer.invoke("kb:list-docs", kbId),
    addFiles: (kbId: string): Promise<KbDocument[]> =>
      ipcRenderer.invoke("kb:add-files", kbId),
    removeDoc: (docId: string): Promise<void> =>
      ipcRenderer.invoke("kb:remove-doc", docId),
    rebuildDoc: (docId: string): Promise<void> =>
      ipcRenderer.invoke("kb:rebuild-doc", docId),
    onIndexingProgress: (callback: (data: KbIndexingProgress) => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: KbIndexingProgress,
      ) => callback(data);
      ipcRenderer.on("kb:indexing-progress", handler);
      return () => ipcRenderer.removeListener("kb:indexing-progress", handler);
    },
  },

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

  // ---- 任务 API ----
  task: {
    create: (prompt: string): Promise<string> =>
      ipcRenderer.invoke("task:create", prompt),
    list: (): Promise<Task[]> => ipcRenderer.invoke("task:list"),
    get: (id: string): Promise<Task | null> =>
      ipcRenderer.invoke("task:get", id),
    cancel: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:cancel", id),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:delete", id),
    onUpdate: (callback: (task: Task) => void) => {
      const handler = (_: Electron.IpcRendererEvent, task: Task) =>
        callback(task);
      ipcRenderer.on("task:update", handler);
      return () => ipcRenderer.removeListener("task:update", handler);
    },
  },

  // ---- Shell ----
  openPath: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("shell:openPath", filePath),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
