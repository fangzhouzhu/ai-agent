import { app } from "electron";
import { join } from "path";
import * as fs from "fs";

function getDataDir(): string {
  const dir = join(app.getPath("userData"), "ai-agent");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getConvDir(): string {
  const dir = join(getDataDir(), "conversations");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const INDEX_FILE = () => join(getDataDir(), "index.json");
const ACTIVE_FILE = () => join(getDataDir(), "active.json");
const SETTINGS_FILE = () => join(getDataDir(), "settings.json");
const AGENTS_FILE = () => join(getDataDir(), "agents.json");
const WECHAT_BOT_MESSAGES_FILE = () => join(getDataDir(), "wechat-bot-messages.json");
const GENERAL_AGENT_ID = "general-assistant";

export interface ConvMeta {
  id: string;
  title: string;
  agentProfileId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: { toolName: string; input: unknown }[];
  toolResults?: { toolName: string; result: string }[];
  modelInfo?: { model: string; scene: string; skill?: string };
  ragContextId?: string;
  durationMs?: number;
  isError?: boolean;
  isStopped?: boolean;
}

export type ModelProvider = "ollama" | "openai-compatible";
export type SkillPreferredScene = "auto" | "chat" | "agent" | "rag";
export type AgentMode = "general" | "domain" | "workflow";

export interface SkillAttachment {
  id: string;
  name: string;
  path: string;
  size: number;
  uploadedAt: number;
}

export interface SkillConfig {
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
}

export interface OnlineProviderSettings {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface OnlineProviderProfile extends Required<OnlineProviderSettings> {
  id: string;
  chatModel?: string;
  agentModel?: string;
  ragModel?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentProfile {
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
}

export interface WechatBotSettings {
  enabled?: boolean;
  qrcode?: string;
  qrContent?: string;
  token?: string;
  chatModel?: string;
  chatProvider?: ModelProvider;
  botId?: string;
  userId?: string;
  nickname?: string;
  status?: "idle" | "waiting_scan" | "bound" | "error" | "unbound";
  lastError?: string;
  boundAt?: number;
  updatedAt?: number;
}

export interface WechatBotPanelMessage {
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
}

export interface ModelSettings {
  chatModel?: string;
  agentModel?: string;
  ragModel?: string;
  chatProvider?: ModelProvider;
  agentProvider?: ModelProvider;
  ragProvider?: ModelProvider;
  online?: OnlineProviderSettings;
  onlineProfiles?: OnlineProviderProfile[];
  activeOnlineProfileId?: string | null;
  skills?: SkillConfig[];
  wechatBot?: WechatBotSettings;
  kbSelectedIds?: string[];
  kbRagOnly?: boolean;
  kbMinScore?: number;
}

function createAgentDefaults() {
  return {
    avatar: undefined as string | undefined,
    mode: "domain" as AgentMode,
    knowledge: {
      defaultKbIds: [] as string[],
      ragOnly: false,
      minScore: 0.6,
      topK: 6,
      fallbackToChat: true,
      citationRequired: false,
    },
    tools: {
      enabledToolNames: [] as string[],
      allowNetwork: false,
      allowWrite: false,
      allowDelete: false,
      requireConfirmationForRisky: true,
    },
    models: {
      forceAgent: true,
    },
    memory: {
      enableConversationSummary: false,
      enableUserPreferenceMemory: false,
    },
    skills: [] as string[],
    isDefault: false,
  };
}

function createGeneralAgentProfile(existing?: Partial<AgentProfile>): AgentProfile {
  const now = Date.now();
  return {
    id: GENERAL_AGENT_ID,
    name: "通用",
    description: "默认通用智能体，用于日常对话、问答与轻量任务。",
    systemPrompt: "",
    ...createAgentDefaults(),
    mode: "general",
    models: {
      forceAgent: false,
    },
    isDefault: true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: existing?.updatedAt ?? now,
  };
}

function readJSON<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function listConversations(): ConvMeta[] {
  return readJSON<Array<Partial<ConvMeta> & Pick<ConvMeta, "id" | "title" | "createdAt" | "updatedAt">>>(INDEX_FILE(), [])
    .map((meta) => ({
      id: meta.id,
      title: meta.title,
      agentProfileId:
        meta.agentProfileId && meta.agentProfileId !== GENERAL_AGENT_ID
          ? meta.agentProfileId
          : null,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getConversationMeta(id: string): ConvMeta | null {
  return listConversations().find((meta) => meta.id === id) ?? null;
}

function saveIndex(metas: ConvMeta[]): void {
  writeJSON(INDEX_FILE(), metas);
}

export function loadConversation(id: string): StoredMessage[] {
  const file = join(getConvDir(), `${id}.json`);
  return readJSON<StoredMessage[]>(file, []);
}

export function saveConversation(meta: ConvMeta, messages: StoredMessage[]): void {
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
  } else {
    metas.unshift(meta);
  }
  saveIndex(metas);

  const file = join(getConvDir(), `${meta.id}.json`);
  writeJSON(file, messages);
}

export function deleteConversation(id: string): void {
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  saveIndex(metas.filter((m) => m.id !== id));
  const file = join(getConvDir(), `${id}.json`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

export function updateConversationMeta(meta: ConvMeta): void {
  const metas = readJSON<ConvMeta[]>(INDEX_FILE(), []);
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx >= 0) {
    metas[idx] = meta;
    saveIndex(metas);
  }
}

export function getActiveId(): string | null {
  return readJSON<{ id: string | null }>(ACTIVE_FILE(), { id: null }).id;
}

export function setActiveId(id: string | null): void {
  writeJSON(ACTIVE_FILE(), { id });
}

export function getModelSettings(): ModelSettings {
  return readJSON<ModelSettings>(SETTINGS_FILE(), {});
}

export function saveModelSettings(settings: ModelSettings): void {
  const prev = getModelSettings();
  writeJSON(SETTINGS_FILE(), { ...prev, ...settings });
}

export function getSkills(): SkillConfig[] {
  const settings = getModelSettings();
  return Array.isArray(settings.skills) ? settings.skills : [];
}

export function saveSkills(skills: SkillConfig[]): void {
  saveModelSettings({ skills });
}

export function getWechatBotSettings(): WechatBotSettings {
  const settings = getModelSettings();
  return settings.wechatBot ?? {};
}

export function saveWechatBotSettings(wechatBot: WechatBotSettings): void {
  const now = Date.now();
  const prev = getWechatBotSettings();
  const token = wechatBot.token?.trim() ?? prev.token;
  saveModelSettings({
    wechatBot: {
      ...prev,
      ...wechatBot,
      token,
      boundAt: token ? (prev.boundAt ?? now) : undefined,
      updatedAt: now,
    },
  });
}

export function loadWechatBotMessages(): WechatBotPanelMessage[] {
  return readJSON<WechatBotPanelMessage[]>(WECHAT_BOT_MESSAGES_FILE(), [])
    .filter((message) => Boolean(message?.id && message?.role && message?.text !== undefined))
    .slice(-80);
}

export function saveWechatBotMessages(messages: WechatBotPanelMessage[]): void {
  writeJSON(WECHAT_BOT_MESSAGES_FILE(), messages.slice(-80));
}

export function getKbUiState(): {
  selectedIds: string[];
  ragOnly: boolean;
  minScore: number;
} {
  const s = getModelSettings();
  return {
    selectedIds: Array.isArray(s.kbSelectedIds) ? s.kbSelectedIds : [],
    ragOnly: s.kbRagOnly !== false,
    minScore: typeof s.kbMinScore === "number" ? s.kbMinScore : 0.6,
  };
}

export function saveKbUiState(
  selectedIds: string[],
  ragOnly: boolean,
  minScore: number,
): void {
  saveModelSettings({
    kbSelectedIds: selectedIds,
    kbRagOnly: ragOnly,
    kbMinScore: minScore,
  });
}

export function listAgentProfiles(): AgentProfile[] {
  const defaults = createAgentDefaults();
  const storedAgents = readJSON<AgentProfile[]>(AGENTS_FILE(), []);
  const generalAgent = createGeneralAgentProfile(
    storedAgents.find((agent) => agent.id === GENERAL_AGENT_ID),
  );
  const agents = storedAgents.filter(
    (agent) =>
      agent.id !== GENERAL_AGENT_ID &&
      agent.name?.trim() !== "通用助手",
  );
  const normalized = agents.map((agent) => ({
    ...defaults,
    ...agent,
    description: agent.description ?? "",
    systemPrompt: agent.systemPrompt ?? "",
    mode: agent.mode ?? defaults.mode,
    knowledge: {
      ...defaults.knowledge,
      ...agent.knowledge,
      defaultKbIds: Array.isArray(agent.knowledge?.defaultKbIds)
        ? Array.from(new Set(agent.knowledge.defaultKbIds.filter(Boolean)))
        : [],
    },
    tools: {
      ...defaults.tools,
      ...agent.tools,
      enabledToolNames: Array.isArray(agent.tools?.enabledToolNames)
        ? Array.from(new Set(agent.tools.enabledToolNames.filter(Boolean)))
        : [],
    },
    models: {
      ...defaults.models,
      ...agent.models,
    },
    memory: {
      ...defaults.memory,
      ...agent.memory,
    },
    skills: Array.isArray(agent.skills)
      ? Array.from(new Set(agent.skills.filter(Boolean)))
      : [],
    isDefault: false,
  }));
  normalized.sort((a, b) => b.updatedAt - a.updatedAt);
  const nextAgents = [generalAgent, ...normalized];
  writeJSON(AGENTS_FILE(), nextAgents);
  return nextAgents;
}

export function getAgentProfile(id: string): AgentProfile | null {
  return listAgentProfiles().find((agent) => agent.id === id) ?? null;
}

export function saveAgentProfile(agent: AgentProfile): AgentProfile {
  if (agent.id === GENERAL_AGENT_ID) {
    return createGeneralAgentProfile(getAgentProfile(GENERAL_AGENT_ID) ?? undefined);
  }

  const defaults = createAgentDefaults();
  const agents = listAgentProfiles();
  const customAgents = agents.filter((item) => item.id !== GENERAL_AGENT_ID);
  const now = Date.now();
  const existing = customAgents.find((item) => item.id === agent.id);
  const next: AgentProfile = {
    ...defaults,
    ...agent,
    createdAt: existing?.createdAt ?? agent.createdAt ?? now,
    updatedAt: now,
    isDefault: false,
    knowledge: {
      ...defaults.knowledge,
      ...agent.knowledge,
      defaultKbIds: Array.from(new Set((agent.knowledge.defaultKbIds ?? []).filter(Boolean))),
    },
    tools: {
      ...defaults.tools,
      ...agent.tools,
      enabledToolNames: Array.from(new Set((agent.tools.enabledToolNames ?? []).filter(Boolean))),
    },
    models: {
      ...defaults.models,
      ...agent.models,
    },
    memory: {
      ...defaults.memory,
      ...agent.memory,
    },
    skills: Array.from(new Set((agent.skills ?? []).filter(Boolean))),
  };

  const nextAgents = existing
    ? customAgents.map((item) => (item.id === next.id ? next : item))
    : [next, ...customAgents];
  writeJSON(AGENTS_FILE(), nextAgents);
  return next;
}

export function deleteAgentProfile(id: string): boolean {
  if (id === GENERAL_AGENT_ID) return false;

  const agents = listAgentProfiles();
  const customAgents = agents.filter((agent) => agent.id !== GENERAL_AGENT_ID);
  const filtered = customAgents.filter((agent) => agent.id !== id);
  if (filtered.length === customAgents.length) return false;
  writeJSON(AGENTS_FILE(), filtered);

  const metas = listConversations().map((meta) =>
    meta.agentProfileId === id
      ? { ...meta, agentProfileId: null, updatedAt: Date.now() }
      : meta,
  );
  saveIndex(metas);
  return true;
}

export function getRagDir(): string {
  const dir = join(getDataDir(), "rag");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRagFilesDir(): string {
  const dir = join(getRagDir(), "files");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getRagVectorsDir(): string {
  const dir = join(getRagDir(), "vectors");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
