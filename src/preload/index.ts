import { contextBridge, ipcRenderer } from "electron";

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type ConvMeta = {
  id: string;
  title: string;
  agentProfileId: string | null;
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
  durationMs?: number;
  isError?: boolean;
  isStopped?: boolean;
};

export type ModelRouteInfo = {
  model: string;
  scene: string;
  skill?: string;
};

export type ChatTokenEvent = {
  conversationId: string;
  token: string;
};

export type ChatToolCallEvent = {
  conversationId: string;
  toolName: string;
  input: unknown;
};

export type ChatToolResultEvent = {
  conversationId: string;
  toolName: string;
  result: string;
};

export type ChatModelInfoEvent = {
  conversationId: string;
  modelInfo: ModelRouteInfo;
};

export type ChatDoneEvent = {
  conversationId: string;
  status: "done" | "aborted";
};

export type ChatErrorEvent = {
  conversationId: string;
  error: string;
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
  | "paused"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "blocked"
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
  checkpoint?: {
    node: string;
    round: number;
    toolCallCount: number;
    updatedAt: number;
    canResume: boolean;
  };
  createdAt: number;
  updatedAt: number;
};

export type ModelProvider = "ollama" | "openai-compatible";
export type SkillPreferredScene = "auto" | "chat" | "agent" | "rag";
export type AgentMode = "general" | "domain" | "workflow";

export type SkillAttachment = {
  id: string;
  name: string;
  path: string;
  size: number;
  uploadedAt: number;
};

export type SkillConfig = {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  systemPrompt: string;
  attachments?: SkillAttachment[];
  enabled: boolean;
  preferredScene: SkillPreferredScene;
  priority: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentProfile = {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  avatar?: string;
  mode: AgentMode;
  knowledge: {
    defaultKbIds: string[];
    ragOnly: boolean;
    minScore: number;
    topK: number;
    fallbackToChat: boolean;
    citationRequired: boolean;
  };
  tools: {
    enabledToolNames: string[];
    allowNetwork: boolean;
    allowWrite: boolean;
    allowDelete: boolean;
    requireConfirmationForRisky: boolean;
  };
  models: {
    forceAgent: boolean;
  };
  memory: {
    enableConversationSummary: boolean;
    enableUserPreferenceMemory: boolean;
  };
  skills: string[];
  isDefault?: boolean;
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

export type WechatBotSettings = {
  enabled?: boolean;
  qrcode?: string;
  qrContent?: string;
  token?: string;
  botId?: string;
  userId?: string;
  nickname?: string;
  status?: "idle" | "waiting_scan" | "bound" | "error" | "unbound";
  lastError?: string;
  boundAt?: number;
  updatedAt?: number;
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

export type WechatBotStatus = {
  status: "idle" | "waiting_scan" | "bound" | "error" | "unbound";
  message: string;
  qrcode?: string;
  qrContent?: string;
  qrDataUrl?: string;
  token?: string;
  botId?: string;
  userId?: string;
  nickname?: string;
  updatedAt: number;
};

export type WechatBotMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  status: "received" | "sent" | "error";
  source?: "wechat" | "panel" | "system";
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  modelInfo?: { model: string; scene: string; skill?: string };
  durationMs?: number;
  isStreaming?: boolean;
  createdAt: number;
};

export type OpenClawGatewayState = {
  running: boolean;
  installing: boolean;
  runtimeReady: boolean;
  lastError?: string;
  logs: string[];
};

export type ToolRisk = "read" | "write" | "delete" | "network" | "system";

export type ToolPolicy = {
  name: string;
  risk: ToolRisk[];
  requiresConfirmation: boolean;
  description: string;
};

export type TraceSummary = {
  traceId: string;
  startedAt: number;
  updatedAt: number;
  eventCount: number;
  lastEventType: string;
};

const api = {
  sendMessage: (
    history: ChatMessage[],
    message: string,
    conversationId: string | null,
    useAgent: boolean,
    fileIds: string[] = [],
    knowledgeOptions?: {
      kbIds?: string[];
      ragOnly?: boolean;
      minScore?: number;
      topK?: number;
      fallbackToChat?: boolean;
      citationRequired?: boolean;
    },
  ) =>
    ipcRenderer.invoke("chat:send", {
      history,
      message,
      conversationId,
      useAgent,
      fileIds,
      ...knowledgeOptions,
    }),

  onToken: (callback: (data: ChatTokenEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatTokenEvent) =>
      callback(data);
    ipcRenderer.on("chat:token", handler);
    return () => ipcRenderer.removeListener("chat:token", handler);
  },

  onToolCall: (callback: (data: ChatToolCallEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatToolCallEvent) =>
      callback(data);
    ipcRenderer.on("chat:tool-call", handler);
    return () => ipcRenderer.removeListener("chat:tool-call", handler);
  },

  onToolResult: (callback: (data: ChatToolResultEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatToolResultEvent) =>
      callback(data);
    ipcRenderer.on("chat:tool-result", handler);
    return () => ipcRenderer.removeListener("chat:tool-result", handler);
  },

  onModelInfo: (callback: (data: ChatModelInfoEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatModelInfoEvent) =>
      callback(data);
    ipcRenderer.on("chat:model-info", handler);
    return () => ipcRenderer.removeListener("chat:model-info", handler);
  },

  onDone: (callback: (data: ChatDoneEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatDoneEvent) =>
      callback(data);
    ipcRenderer.on("chat:done", handler);
    return () => ipcRenderer.removeListener("chat:done", handler);
  },

  onError: (callback: (data: ChatErrorEvent) => void) => {
    const handler = (_: Electron.IpcRendererEvent, data: ChatErrorEvent) =>
      callback(data);
    ipcRenderer.on("chat:error", handler);
    return () => ipcRenderer.removeListener("chat:error", handler);
  },

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

  getWechatBotSettings: (): Promise<WechatBotSettings> =>
    ipcRenderer.invoke("settings:get-wechat-bot"),
  saveWechatBotSettings: (
    settings: WechatBotSettings,
  ): Promise<WechatBotSettings> =>
    ipcRenderer.invoke("settings:save-wechat-bot", settings),
  refreshWechatBotQr: (): Promise<WechatBotStatus> =>
    ipcRenderer.invoke("settings:refresh-wechat-bot-qr"),
  getWechatBotStatus: (): Promise<WechatBotStatus> =>
    ipcRenderer.invoke("settings:get-wechat-bot-status"),
  getOpenClawGatewayState: (): Promise<OpenClawGatewayState> =>
    ipcRenderer.invoke("settings:get-openclaw-gateway-state"),
  restartOpenClawGateway: (): Promise<OpenClawGatewayState> =>
    ipcRenderer.invoke("settings:restart-openclaw-gateway"),
  unbindWechatBot: (): Promise<WechatBotStatus> =>
    ipcRenderer.invoke("settings:unbind-wechat-bot"),
  sendWechatBotMessage: (
    history: ChatMessage[],
    message: string,
  ): Promise<string> =>
    ipcRenderer.invoke("wechat-bot:send-message", { history, message }),
  listWechatBotMessages: (): Promise<WechatBotMessage[]> =>
    ipcRenderer.invoke("wechat-bot:list-messages"),
  onWechatBotUpdate: (
    callback: (data: {
      status: WechatBotStatus;
      messages: WechatBotMessage[];
    }) => void,
  ) => {
    const handler = (
      _: Electron.IpcRendererEvent,
      data: { status: WechatBotStatus; messages: WechatBotMessage[] },
    ) => callback(data);
    ipcRenderer.on("wechat-bot:update", handler);
    return () => ipcRenderer.removeListener("wechat-bot:update", handler);
  },

  listSkills: (): Promise<SkillConfig[]> => ipcRenderer.invoke("skills:list"),
  saveSkills: (skills: SkillConfig[]): Promise<SkillConfig[]> =>
    ipcRenderer.invoke("skills:save", skills),
  pickSkillFiles: (): Promise<SkillAttachment[]> =>
    ipcRenderer.invoke("skills:pick-files"),

  listToolPolicies: (): Promise<ToolPolicy[]> =>
    ipcRenderer.invoke("tools:list-policies"),
  diagnostics: {
    listTraces: (): Promise<TraceSummary[]> =>
      ipcRenderer.invoke("diagnostics:list-traces"),
    getTrace: (traceId: string): Promise<unknown[]> =>
      ipcRenderer.invoke("diagnostics:get-trace", traceId),
  },

  getKbUiState: (): Promise<{
    selectedIds: string[];
    ragOnly: boolean;
    minScore: number;
  }> => ipcRenderer.invoke("kb:get-ui-state"),
  saveKbUiState: (
    selectedIds: string[],
    ragOnly: boolean,
    minScore: number,
  ): Promise<void> =>
    ipcRenderer.invoke("kb:save-ui-state", selectedIds, ragOnly, minScore),

  abortChat: (conversationId: string | null) =>
    ipcRenderer.send("chat:abort", conversationId),

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

  agents: {
    list: (): Promise<AgentProfile[]> => ipcRenderer.invoke("agents:list"),
    save: (agent: AgentProfile): Promise<AgentProfile> =>
      ipcRenderer.invoke("agents:save", agent),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("agents:delete", id),
  },

  storage: {
    list: (): Promise<ConvMeta[]> => ipcRenderer.invoke("storage:list"),
    load: (id: string): Promise<StoredMessage[]> =>
      ipcRenderer.invoke("storage:load", id),
    save: (meta: ConvMeta, messages: StoredMessage[]): Promise<void> =>
      ipcRenderer.invoke("storage:save", meta, messages),
    updateMeta: (meta: ConvMeta): Promise<void> =>
      ipcRenderer.invoke("storage:update-meta", meta),
    delete: (id: string): Promise<void> =>
      ipcRenderer.invoke("storage:delete", id),
    getActive: (): Promise<string | null> =>
      ipcRenderer.invoke("storage:get-active"),
    setActive: (id: string | null): Promise<void> =>
      ipcRenderer.invoke("storage:set-active", id),
  },

  task: {
    create: (prompt: string): Promise<string> =>
      ipcRenderer.invoke("task:create", prompt),
    list: (): Promise<Task[]> => ipcRenderer.invoke("task:list"),
    get: (id: string): Promise<Task | null> =>
      ipcRenderer.invoke("task:get", id),
    cancel: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:cancel", id),
    pause: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:pause", id),
    resume: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:resume", id),
    rerun: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:rerun", id),
    delete: (id: string): Promise<boolean> =>
      ipcRenderer.invoke("task:delete", id),
    onUpdate: (callback: (task: Task) => void) => {
      const handler = (_: Electron.IpcRendererEvent, task: Task) =>
        callback(task);
      ipcRenderer.on("task:update", handler);
      return () => ipcRenderer.removeListener("task:update", handler);
    },
  },

  openPath: (filePath: string): Promise<string | null> =>
    ipcRenderer.invoke("shell:openPath", filePath),
};

contextBridge.exposeInMainWorld("electronAPI", api);

export type ElectronAPI = typeof api;
