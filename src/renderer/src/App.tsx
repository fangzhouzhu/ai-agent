import React, { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import { useMemo } from 'react'
import ChatArea from './components/ChatArea'
import InputBar from './components/InputBar'
import KnowledgeBasePanel from './components/KnowledgeBase'
import SkillsPanel from './components/SkillsPanel'
import WechatBotPanel from './components/WechatBotPanel'
import { useAppDialog } from './components/AppDialogProvider'
import type { Task } from '../../preload/index'

const TitleBar: React.FC = () => (
  <div style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    height: '38px',
    background: 'linear-gradient(180deg, rgba(244, 248, 255, 0.96), rgba(238, 244, 255, 0.84))',
    display: 'flex',
    alignItems: 'center',
    zIndex: 9999,
    borderBottom: '1px solid rgba(207, 218, 247, 0.72)',
    boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.9)',
    WebkitAppRegion: 'drag' as any,
    userSelect: 'none',
  }}>
   
  </div>
)

import {
  type Conversation,
  type ConvMeta,
  type Message,
  createConversation,
  createMessage,
  generateTitle,
  toStoredMessage,
} from './types/conversation'
import { v4 as uuidv4 } from 'uuid'
import styles from './App.module.css'

const TASK_MODEL_INFO = {
  model: 'Task Runner',
  scene: '后台任务',
} as const

function buildTaskTitle(prompt: string): string {
  return prompt.slice(0, 60) + (prompt.length > 60 ? '…' : '')
}

function createPendingTaskSnapshot(taskId: string, prompt: string): Task {
  const now = Date.now()
  return {
    id: taskId,
    title: buildTaskTitle(prompt),
    prompt,
    status: 'pending',
    steps: [],
    result: '',
    outputFiles: [],
    checkpoint: {
      node: 'created',
      round: 0,
      toolCallCount: 0,
      updatedAt: now,
      canResume: true,
    },
    createdAt: now,
    updatedAt: now,
  }
}

function getTaskErrorSummary(task: Task): string {
  const latestError = [...task.steps].reverse().find((step) => step.type === 'error')
  return latestError?.content?.trim() || '任务执行失败，请查看步骤详情。'
}

function getTaskMessageContent(task: Task): string {
  const result = task.result.trim()
  if (result) return result

  if (task.status === 'completed') {
    return task.outputFiles.length > 0
      ? '任务已完成，生成的文件可在下方任务卡片中直接打开。'
      : '任务已完成。'
  }

  if (task.status === 'failed') return `任务失败：${getTaskErrorSummary(task)}`
  if (task.status === 'cancelled') return '任务已取消，历史步骤已保留。'
  if (task.status === 'paused') return '任务已暂停，可在当前消息中继续执行。'
  if (task.status === 'blocked') return '任务因中断被阻塞，可继续执行或重新运行。'
  if (task.status === 'waiting_for_approval' || task.status === 'waiting_for_input') {
    return '任务正在等待处理。'
  }

  return '后台任务已创建，进度会持续同步到当前对话。'
}

type RagFileMeta = {
  id: string
  name: string
  path: string
  chunks: number
  uploadedAt: number
}

type KnowledgeBase = {
  id: string
  name: string
  description: string
  embeddingModel: string
  chunkSize: number
  chunkOverlap: number
  docCount: number
  chunkCount: number
  createdAt: number
  updatedAt: number
}

type ModelProvider = 'ollama' | 'openai-compatible'

type RouteModelConfig = {
  provider: ModelProvider
  model: string
}

type SavedOnlineProfile = {
  id: string
  name: string
  provider: string
  baseUrl: string
  apiKey: string
  chatModel?: string
  agentModel?: string
  ragModel?: string
  models?: string[]
  createdAt: number
  updatedAt: number
}

type OnlineProviderConfig = {
  name: string
  provider: string
  baseUrl: string
  apiKey: string
}

type WechatBotConfig = {
  enabled: boolean
  qrcode: string
  qrContent: string
  token: string
  botId?: string
  userId?: string
  nickname?: string
  status?: WechatBotBindStatus
  lastError?: string
  boundAt?: number
  updatedAt?: number
}

type ModelRouteConfig = {
  chat: RouteModelConfig
  agent: RouteModelConfig
  rag: RouteModelConfig
  online: OnlineProviderConfig
  onlineProfiles: SavedOnlineProfile[]
  activeOnlineProfileId: string | null
}

type SkillPreferredScene = 'auto' | 'chat' | 'agent' | 'rag'

type SkillConfig = {
  id: string
  name: string
  description: string
  keywords: string[]
  systemPrompt: string
  attachments?: {
    id: string
    name: string
    path: string
    size: number
    uploadedAt: number
  }[]
  enabled: boolean
  preferredScene: SkillPreferredScene
  priority: number
  createdAt: number
  updatedAt: number
}

type AgentMode = 'general' | 'domain' | 'workflow'

function getAgentModeLabel(mode: AgentMode): string {
  if (mode === 'general') return '通用助手'
  if (mode === 'workflow') return '流程助手'
  return '专业助手'
}

const agentModeDescriptions: Record<
  AgentMode,
  {
    title: string
    description: string
    example: string
  }
> = {
  domain: {
    title: '专业助手',
    description: '适合固定专业场景，强调身份、知识边界和回答口径。',
    example: '例如 HR、法务、财务、产品顾问。',
  },
  workflow: {
    title: '流程助手',
    description: '适合有明确步骤的任务，强调按流程推进、检查和交付结果。',
    example: '例如面试流程、入职办理、周报生成、数据整理。',
  },
  general: {
    title: '通用助手',
    description: '适合日常聊天和泛问答，不强绑定某个专业角色或固定流程。',
    example: '例如日常咨询、灵感发散、普通问答。',
  },
}

type AgentProfile = {
  id: string
  name: string
  description: string
  systemPrompt: string
  avatar?: string
  mode: AgentMode
  knowledge: {
    defaultKbIds: string[]
    ragOnly: boolean
    minScore: number
    topK: number
    fallbackToChat: boolean
    citationRequired: boolean
  }
  tools: {
    enabledToolNames: string[]
    allowNetwork: boolean
    allowWrite: boolean
    allowDelete: boolean
    requireConfirmationForRisky: boolean
  }
  models: {
    forceAgent: boolean
  }
  memory: {
    enableConversationSummary: boolean
    enableUserPreferenceMemory: boolean
  }
  skills: string[]
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

const GENERAL_AGENT_ID = 'general-assistant'

function isLockedAgent(agent: Pick<AgentProfile, 'id' | 'isDefault'>): boolean {
  return agent.id === GENERAL_AGENT_ID || Boolean(agent.isDefault)
}

type ApiTestState = {
  status: 'idle' | 'testing' | 'success' | 'error'
  message: string
  models: string[]
  latencyMs?: number
  balanceInfo?: string
  testedAt?: number
}

type WechatBotBindStatus = 'idle' | 'waiting_scan' | 'bound' | 'error' | 'unbound'

type BotBindState = {
  status: WechatBotBindStatus
  message: string
  qrcode?: string
  qrContent?: string
  qrDataUrl?: string
  token?: string
  botId?: string
  userId?: string
  nickname?: string
  updatedAt?: number
}

type ToolPolicy = {
  name: string
  risk: Array<'read' | 'write' | 'delete' | 'network' | 'system'>
  requiresConfirmation: boolean
  description: string
}

type TraceSummary = {
  traceId: string
  startedAt: number
  updatedAt: number
  eventCount: number
  lastEventType: string
}

const defaultModelConfig: ModelRouteConfig = {
  chat: { provider: 'ollama', model: 'qwen2.5:3b' },
  agent: { provider: 'ollama', model: 'qwen2.5:3b' },
  rag: { provider: 'ollama', model: 'qwen2.5:3b' },
  online: {
    name: '默认在线配置',
    provider: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
  },
  onlineProfiles: [],
  activeOnlineProfileId: null,
}

const defaultWechatBotConfig: WechatBotConfig = {
  enabled: false,
  qrcode: '',
  qrContent: '',
  token: '',
  status: 'idle',
}

function sanitizeAssistantContent(text: string): string {
  return text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, ' ')
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, ' ')
    .replace(/<arg_key>[\s\S]*?(?:<\/arg_key>|$)/gi, ' ')
    .replace(/<arg_value>[\s\S]*?(?:<\/arg_value>|$)/gi, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trimStart()
}

function normalizeModelConfig(config?: {
  chatModel?: string
  agentModel?: string
  ragModel?: string
  chatProvider?: ModelProvider
  agentProvider?: ModelProvider
  ragProvider?: ModelProvider
  online?: Partial<OnlineProviderConfig>
  onlineProfiles?: SavedOnlineProfile[]
  activeOnlineProfileId?: string | null
} | null): ModelRouteConfig {
  return {
    chat: {
      provider: config?.chatProvider ?? defaultModelConfig.chat.provider,
      model: config?.chatModel ?? defaultModelConfig.chat.model,
    },
    agent: {
      provider: config?.agentProvider ?? defaultModelConfig.agent.provider,
      model: config?.agentModel ?? defaultModelConfig.agent.model,
    },
    rag: {
      provider: config?.ragProvider ?? defaultModelConfig.rag.provider,
      model: config?.ragModel ?? defaultModelConfig.rag.model,
    },
    online: {
      name: config?.online?.name ?? defaultModelConfig.online.name,
      provider: config?.online?.provider ?? defaultModelConfig.online.provider,
      baseUrl: config?.online?.baseUrl ?? defaultModelConfig.online.baseUrl,
      apiKey: config?.online?.apiKey ?? defaultModelConfig.online.apiKey,
    },
    onlineProfiles: config?.onlineProfiles ?? [],
    activeOnlineProfileId: config?.activeOnlineProfileId ?? null,
  }
}

function normalizeWechatBotConfig(config?: Partial<WechatBotConfig> | null): WechatBotConfig {
  return {
    enabled: Boolean(config?.enabled),
    qrcode: config?.qrcode ?? '',
    qrContent: config?.qrContent ?? '',
    token: config?.token ?? '',
    botId: config?.botId,
    userId: config?.userId,
    nickname: config?.nickname,
    status: config?.status ?? 'idle',
    lastError: config?.lastError,
    boundAt: config?.boundAt,
    updatedAt: config?.updatedAt,
  }
}

function toSettingsPayload(config: ModelRouteConfig) {
  return {
    chatModel: config.chat.model,
    agentModel: config.agent.model,
    ragModel: config.rag.model,
    chatProvider: config.chat.provider,
    agentProvider: config.agent.provider,
    ragProvider: config.rag.provider,
    online: { ...config.online },
    onlineProfiles: config.onlineProfiles,
    activeOnlineProfileId: config.activeOnlineProfileId,
  }
}

function maskApiKey(value: string): string {
  if (!value) return '未填写'
  if (value.length <= 8) return '••••••'
  return `${value.slice(0, 3)}••••${value.slice(-4)}`
}

const onlineProviderPresets: Record<string, string> = {
  OpenAI: 'https://api.openai.com/v1',
  DeepSeek: 'https://api.deepseek.com/v1',
  Moonshot: 'https://api.moonshot.cn/v1',
  SiliconFlow: 'https://api.siliconflow.cn/v1',
  '智谱 AI': 'https://open.bigmodel.cn/api/paas/v4',
  OpenRouter: 'https://openrouter.ai/api/v1',
  Custom: '',
}

const providerModelPresets: Record<string, string[]> = {
  OpenAI: ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1'],
  DeepSeek: ['deepseek-chat', 'deepseek-reasoner'],
  Moonshot: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
  SiliconFlow: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
  '智谱 AI': ['glm-4-flash', 'glm-4-plus', 'glm-4-air', 'glm-4-airx', 'glm-4v-flash'],
  OpenRouter: ['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'google/gemini-2.0-flash-001'],
  Custom: [],
}

const ROUTE_ITEMS: Array<{ key: keyof Pick<ModelRouteConfig, 'chat' | 'agent' | 'rag'>; label: string }> = [
  { key: 'chat', label: '普通聊天' },
  { key: 'agent', label: '复杂任务 / Agent' },
  { key: 'rag', label: '文档问答 / RAG' },
]

function createEmptySkill(): SkillConfig {
  const now = Date.now()
  return {
    id: uuidv4(),
    name: '新技能',
    description: '',
    keywords: [],
    systemPrompt: '',
    enabled: true,
    preferredScene: 'auto',
    priority: 50,
    createdAt: now,
    updatedAt: now,
  }
}

function parseSkillKeywords(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[\n,，]/)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  )
}

function formatSkillKeywords(keywords: string[]): string {
  return keywords.join(', ')
}

function createEmptyAgent(): AgentProfile {
  const now = Date.now()
  return {
    id: uuidv4(),
    name: '',
    description: '',
    systemPrompt: '',
    mode: 'domain',
    knowledge: {
      defaultKbIds: [],
      ragOnly: false,
      minScore: 0.6,
      topK: 6,
      fallbackToChat: true,
      citationRequired: false,
    },
    tools: {
      enabledToolNames: [],
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
    skills: [],
    createdAt: now,
    updatedAt: now,
  }
}

function normalizeDraftSkills(skills: SkillConfig[]): SkillConfig[] {
  return skills
    .map((skill) => ({
      ...skill,
      name: skill.name.trim(),
      description: skill.description.trim(),
      systemPrompt: skill.systemPrompt.trim(),
      keywords: Array.from(new Set(skill.keywords.map((item) => item.trim()).filter(Boolean))),
      preferredScene: 'auto' as SkillPreferredScene,
      priority: Math.max(0, Math.min(100, Number(skill.priority) || 0)),
      updatedAt: Date.now(),
    }))
    .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)
}

const App: React.FC = () => {
  const { confirm } = useAppDialog()
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loadingConversationIds, setLoadingConversationIds] = useState<string[]>([])
  const [ragFiles, setRagFiles] = useState<RagFileMeta[]>([])
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([])
  const [isRagProcessing, setIsRagProcessing] = useState(false)
  const [ragStatusText, setRagStatusText] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelConfig, setModelConfig] = useState<ModelRouteConfig>(defaultModelConfig)
  const [draftModelConfig, setDraftModelConfig] = useState<ModelRouteConfig>(defaultModelConfig)
  const [agents, setAgents] = useState<AgentProfile[]>([])
  const [agentEditorDraft, setAgentEditorDraft] = useState<AgentProfile | null>(null)
  const [showAgentModal, setShowAgentModal] = useState(false)
  const [agentModalMode, setAgentModalMode] = useState<'new' | 'edit'>('new')
  const [activeAgentMenuId, setActiveAgentMenuId] = useState<string | null>(null)
  const [agentKbPickerOpen, setAgentKbPickerOpen] = useState(false)
  const [agentKbSearch, setAgentKbSearch] = useState('')
  const [agentModeInfoOpen, setAgentModeInfoOpen] = useState(false)
  const [agentModeInfoPosition, setAgentModeInfoPosition] = useState({ top: 0, left: 0 })
  const [pendingAgentId, setPendingAgentId] = useState<string | null>(null)
  const [wechatBotConfig, setWechatBotConfig] = useState<WechatBotConfig>(defaultWechatBotConfig)
  const [draftWechatBotConfig, setDraftWechatBotConfig] = useState<WechatBotConfig>(defaultWechatBotConfig)
  const [showModelConfig, setShowModelConfig] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'models' | 'wechat' | 'skills' | 'tools' | 'diagnostics'>('models')
  const [draftSkills, setDraftSkills] = useState<SkillConfig[]>([])
  const [skillEditorDraft, setSkillEditorDraft] = useState<SkillConfig | null>(null)
  const [skillEditorMode, setSkillEditorMode] = useState<'new' | 'edit' | null>(null)
  const [skillEditorSessionId, setSkillEditorSessionId] = useState(() => uuidv4())
  const [toolPolicies, setToolPolicies] = useState<ToolPolicy[]>([])
  const [traceSummaries, setTraceSummaries] = useState<TraceSummary[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [apiTestState, setApiTestState] = useState<ApiTestState>({
    status: 'idle',
    message: '',
    models: [],
  })
  const [botBindState, setBotBindState] = useState<BotBindState>({
    status: 'idle',
    message: '',
  })
  const [ragContextId, setRagContextId] = useState(() => uuidv4())
  const [currentView, setCurrentView] = useState<'chat' | 'agents' | 'kb' | 'skills' | 'wechat'>('chat')
  const [activeKbId, setActiveKbId] = useState<string | null>(null)
  const [runningTaskCount, setRunningTaskCount] = useState(0)
  const ragFilesRef = useRef<RagFileMeta[]>([])
  const streamingMsgIdRef = useRef<Record<string, string | null>>({})
  const tokenQueueRef = useRef<Record<string, string>>({})
  const typingTimerRef = useRef<Record<string, ReturnType<typeof setInterval> | null>>({})
  const skillFormRef = useRef<HTMLFormElement | null>(null)
  const agentKbPickerRef = useRef<HTMLDivElement | null>(null)
  const agentModeInfoRef = useRef<HTMLDivElement | null>(null)
  const agentModeInfoButtonRef = useRef<HTMLButtonElement | null>(null)

  const refreshModelConfig = useCallback(async () => {
    const [availableModels, savedConfig, savedSkills, savedWechatBot, policies, traces, savedAgents, savedKnowledgeBases] = await Promise.all([
      window.electronAPI.listModels(),
      window.electronAPI.getModelConfig(),
      window.electronAPI.listSkills(),
      window.electronAPI.getWechatBotSettings(),
      window.electronAPI.listToolPolicies(),
      window.electronAPI.diagnostics.listTraces(),
      window.electronAPI.agents.list(),
      window.electronAPI.kb.list(),
    ])

    const nextConfig = normalizeModelConfig(savedConfig)
    const nextWechatBotConfig = normalizeWechatBotConfig(savedWechatBot)
    const nextSkills = [...savedSkills].sort(
      (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt
    )

    setModels(availableModels)
    setModelConfig(nextConfig)
    setDraftModelConfig(nextConfig)
    setAgents(savedAgents)
    setKnowledgeBases(savedKnowledgeBases)
    setAgentEditorDraft(null)
    setPendingAgentId((current) => savedAgents.some((agent) => agent.id === current) ? current : null)
    setWechatBotConfig(nextWechatBotConfig)
    setDraftWechatBotConfig(nextWechatBotConfig)
    setDraftSkills(nextSkills)
    setSkillEditorDraft(nextSkills[0] ? { ...nextSkills[0], keywords: [...nextSkills[0].keywords] } : null)
    setSkillEditorMode(nextSkills[0] ? 'edit' : null)
    setSkillEditorSessionId(uuidv4())
    setToolPolicies(policies)
    setTraceSummaries(traces)
    setActiveSkillId(nextSkills[0]?.id ?? null)
    setApiTestState({ status: 'idle', message: '', models: [] })
    setBotBindState({
      status: nextWechatBotConfig.status ?? 'idle',
      message: nextWechatBotConfig.nickname
        ? `已绑定微信 ClawBot：${nextWechatBotConfig.nickname}`
        : '',
      qrcode: nextWechatBotConfig.qrcode,
      qrContent: nextWechatBotConfig.qrContent,
      token: nextWechatBotConfig.token,
      botId: nextWechatBotConfig.botId,
      userId: nextWechatBotConfig.userId,
      nickname: nextWechatBotConfig.nickname,
      updatedAt: nextWechatBotConfig.updatedAt,
    })
  }, [])
  // 初始化：从文件加载索引
  useEffect(() => {
    const init = async () => {
      if (!window.electronAPI?.storage) {
        console.error('electronAPI.storage 未就绪，请重启应用')
        return
      }
      const [metas, activeIdStored, uploaded] = await Promise.all([
        window.electronAPI.storage.list(),
        window.electronAPI.storage.getActive(),
        window.electronAPI.rag.list(),
      ])

      const convs: Conversation[] = metas.map((m) => ({
        ...m,
        messages: [],
        loaded: false,
      }))
      setConversations(convs)

      if (activeIdStored && metas.find((m) => m.id === activeIdStored)) {
        setActiveId(activeIdStored)
      } else if (metas.length > 0) {
        setActiveId(metas[0].id)
      }

      setRagFiles(uploaded)
      ragFilesRef.current = uploaded
      await refreshModelConfig()
    }
    init()
  }, [refreshModelConfig])

  useEffect(() => {
    const remove = window.electronAPI.task.onUpdate((task) => {
      window.electronAPI.task.list().then((list) => {
        setRunningTaskCount(list.filter((t) => t.status === 'running').length)
      })

      setConversations((prev) => {
        const changedConversations: Conversation[] = []
        const updated = prev.map((conv) => {
          let touched = false
          const nextMessages = conv.messages.map((message) => {
            if (message.task?.id !== task.id) return message
            touched = true
            return {
              ...message,
              task,
              content: getTaskMessageContent(task),
              modelInfo: message.modelInfo ?? TASK_MODEL_INFO,
            }
          })

          if (!touched) return conv

          const nextConversation = {
            ...conv,
            messages: nextMessages,
            updatedAt: Date.now(),
          }
          changedConversations.push(nextConversation)
          return nextConversation
        })

        changedConversations.forEach((conversation) => {
          const meta: ConvMeta = {
            id: conversation.id,
            title: conversation.title,
            agentProfileId: conversation.agentProfileId,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
          }
          const messages = conversation.messages
            .filter((message) => !message.isStreaming)
            .map(toStoredMessage)
          window.electronAPI.storage.save(meta, messages)
        })
        return updated
      })
    })
    return remove
  }, [])

  useEffect(() => {
    const removeRagStatus = window.electronAPI.rag.onStatus((data) => {
      setRagStatusText(data.message || '')

      if (data.status === 'processing') {
        setIsRagProcessing(true)
      } else if (data.status === 'error' || data.status === 'idle') {
        setIsRagProcessing(false)
      }
    })

    return () => {
      removeRagStatus()
    }
  }, [])

  // 切换到某个对话时懒加载消息
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv || conv.loaded) return

    window.electronAPI.storage.load(activeId).then((storedMsgs) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? { ...c, messages: storedMsgs as Message[], loaded: true }
            : c
        )
      )
    })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 持久化活跃 ID
  useEffect(() => {
    if (activeId) window.electronAPI.storage.setActive(activeId)
  }, [activeId])

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null
  const activeConversationAgent = agents.find((agent) => agent.id === activeConversation?.agentProfileId) ?? null
  const pendingAgent = agents.find((agent) => agent.id === pendingAgentId) ?? null
  const selectableAgents = agents.filter((agent) => !isLockedAgent(agent))
  const currentAgentModeDescription = agentModeDescriptions[agentEditorDraft?.mode ?? 'domain']
  const activeIsLoading = activeId ? loadingConversationIds.includes(activeId) : false

  const isConversationLoading = useCallback(
    (conversationId: string | null | undefined) =>
      Boolean(conversationId && loadingConversationIds.includes(conversationId)),
    [loadingConversationIds]
  )

  const markConversationLoading = useCallback((conversationId: string) => {
    setLoadingConversationIds((prev) =>
      prev.includes(conversationId) ? prev : [...prev, conversationId]
    )
  }, [])

  const clearConversationLoading = useCallback((conversationId: string) => {
    setLoadingConversationIds((prev) => prev.filter((id) => id !== conversationId))
  }, [])

  const cloneAgent = useCallback((agent: AgentProfile): AgentProfile => ({
    ...agent,
    knowledge: { ...agent.knowledge, defaultKbIds: [...agent.knowledge.defaultKbIds] },
    tools: { ...agent.tools, enabledToolNames: [...agent.tools.enabledToolNames] },
    models: { ...agent.models },
    memory: { ...agent.memory },
    skills: [...agent.skills],
  }), [])

  const toggleDraftKnowledgeBase = useCallback((kbId: string) => {
    setAgentEditorDraft((prev) => {
      if (!prev) return prev

      const exists = prev.knowledge.defaultKbIds.includes(kbId)
      return {
        ...prev,
        knowledge: {
          ...prev.knowledge,
          defaultKbIds: exists
            ? prev.knowledge.defaultKbIds.filter((id) => id !== kbId)
            : [...prev.knowledge.defaultKbIds, kbId],
        },
      }
    })
  }, [])

  const selectedKnowledgeBases = knowledgeBases.filter((kb) =>
    agentEditorDraft?.knowledge.defaultKbIds.includes(kb.id)
  )

  const filteredKnowledgeBases = useMemo(() => {
    const keyword = agentKbSearch.trim().toLowerCase()
    if (!keyword) return knowledgeBases

    return knowledgeBases.filter((kb) =>
      [kb.name, kb.description]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(keyword))
    )
  }, [agentKbSearch, knowledgeBases])

  useEffect(() => {
    if (!agentKbPickerOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!agentKbPickerRef.current?.contains(event.target as Node)) {
        setAgentKbPickerOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [agentKbPickerOpen])

  useEffect(() => {
    if (!agentModeInfoOpen) return

    const updatePosition = () => {
      const rect = agentModeInfoButtonRef.current?.getBoundingClientRect()
      if (!rect) return
      setAgentModeInfoPosition({
        top: rect.bottom + 10,
        left: Math.min(rect.left - 8, window.innerWidth - 300),
      })
    }

    updatePosition()

    const handlePointerDown = (event: MouseEvent) => {
      if (!agentModeInfoRef.current?.contains(event.target as Node)) {
        setAgentModeInfoOpen(false)
      }
    }

    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', updatePosition, true)
    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', updatePosition, true)
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [agentModeInfoOpen])

  useEffect(() => {
    if (!showAgentModal) {
      setAgentKbPickerOpen(false)
      setAgentKbSearch('')
      setAgentModeInfoOpen(false)
    }
  }, [showAgentModal])

  const persistAgent = useCallback(async (agent: AgentProfile) => {
    const saved = await window.electronAPI.agents.save(agent)
    setAgents((prev) => {
      const exists = prev.some((item) => item.id === saved.id)
      const next = exists ? prev.map((item) => item.id === saved.id ? saved : item) : [saved, ...prev]
      return next.sort((a, b) => b.updatedAt - a.updatedAt)
    })
    if (agentEditorDraft?.id === saved.id) {
      setAgentEditorDraft(cloneAgent(saved))
    }
    return saved
  }, [agentEditorDraft?.id, cloneAgent])

  const handleSelectConversationAgent = useCallback(async (agentId: string) => {
    const normalizedAgentId = agentId === GENERAL_AGENT_ID ? '' : agentId

    if (activeConversation && activeConversation.messages.length > 0) {
      return
    }

    if (!activeConversation) {
      setPendingAgentId(normalizedAgentId || null)
      return
    }

    const updatedConversation: Conversation = {
      ...activeConversation,
      agentProfileId: normalizedAgentId || null,
      updatedAt: Date.now(),
    }
    setConversations((prev) => prev.map((item) => item.id === updatedConversation.id ? updatedConversation : item))
    await window.electronAPI.storage.updateMeta({
      id: updatedConversation.id,
      title: updatedConversation.title,
      agentProfileId: updatedConversation.agentProfileId,
      createdAt: updatedConversation.createdAt,
      updatedAt: updatedConversation.updatedAt,
    })
  }, [activeConversation])

  // 保存单条对话到磁盘
  const persistConversation = useCallback((conv: Conversation) => {
    const meta: ConvMeta = {
      id: conv.id,
      title: conv.title,
      agentProfileId: conv.agentProfileId,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    }
    const messages = conv.messages
      .filter((m) => !m.isStreaming)
      .map(toStoredMessage)
    window.electronAPI.storage.save(meta, messages)
  }, [])

  // 新建对话
  const handleNew = useCallback(() => {
    setPendingAgentId(null)
    setActiveId(null)
    setCurrentView('chat')
    setRagContextId(uuidv4())
    window.electronAPI.storage.setActive(null)
  }, [])

  // 切换对话
  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
    setCurrentView('chat')
  }, [])

  // 删除对话
  const handleDelete = useCallback(
    (id: string) => {
      window.electronAPI.storage.delete(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) {
        const remaining = conversations.filter((c) => c.id !== id)
        const nextId = remaining.length > 0 ? remaining[0].id : null
        setActiveId(nextId)
        if (nextId === null) window.electronAPI.storage.setActive(null)
      }
    },
    [activeId, conversations]
  )

  const handleRenameConversation = useCallback(async (id: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return

    let updatedConversation: Conversation | null = null

    setConversations((prev) =>
      prev.map((conv) => {
        if (conv.id !== id) return conv
        updatedConversation = {
          ...conv,
          title: nextTitle,
          updatedAt: Date.now(),
        }
        return updatedConversation
      })
    )

    if (!updatedConversation) return

    await window.electronAPI.storage.updateMeta({
      id: updatedConversation.id,
      title: updatedConversation.title,
      agentProfileId: updatedConversation.agentProfileId,
      createdAt: updatedConversation.createdAt,
      updatedAt: updatedConversation.updatedAt,
    })
  }, [])

  const updateOnlineConfig = useCallback((patch: Partial<OnlineProviderConfig>) => {
    setDraftModelConfig((prev) => ({
      ...prev,
      online: {
        ...prev.online,
        ...patch,
      },
    }))
  }, [])

  const updateWechatBotConfig = useCallback((patch: Partial<WechatBotConfig>) => {
    setDraftWechatBotConfig((prev) => ({
      ...prev,
      ...patch,
    }))
    setBotBindState((prev) => ({
      ...prev,
      message: '',
    }))
  }, [])

  const applyOnlineProfile = useCallback((profileId: string) => {
    setDraftModelConfig((prev) => {
      const profile = prev.onlineProfiles.find((item) => item.id === profileId)
      if (!profile) return prev

      return {
        ...prev,
        activeOnlineProfileId: profile.id,
        online: {
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
        },
        chat:
          prev.chat.provider === 'openai-compatible'
            ? { ...prev.chat, model: profile.chatModel || prev.chat.model }
            : prev.chat,
        agent:
          prev.agent.provider === 'openai-compatible'
            ? { ...prev.agent, model: profile.agentModel || prev.agent.model }
            : prev.agent,
        rag:
          prev.rag.provider === 'openai-compatible'
            ? { ...prev.rag, model: profile.ragModel || prev.rag.model }
            : prev.rag,
      }
    })

    setApiTestState({
      status: 'idle',
      message: '已切换到在线预设，点击“保存配置”后会正式生效。',
      models: [],
    })
  }, [])

  const handleSaveOnlineProfile = useCallback(() => {
    const profileName = draftModelConfig.online.name.trim()
    if (!profileName) {
      window.alert('请先填写预设名称')
      return
    }

    const now = Date.now()
    const existing = draftModelConfig.onlineProfiles.find(
      (item) => item.id === draftModelConfig.activeOnlineProfileId
    )
    const profileId = existing?.id ?? uuidv4()

    const nextProfile: SavedOnlineProfile = {
      id: profileId,
      name: profileName,
      provider: draftModelConfig.online.provider,
      baseUrl: draftModelConfig.online.baseUrl,
      apiKey: draftModelConfig.online.apiKey,
      chatModel: draftModelConfig.chat.provider === 'openai-compatible' ? draftModelConfig.chat.model : undefined,
      agentModel: draftModelConfig.agent.provider === 'openai-compatible' ? draftModelConfig.agent.model : undefined,
      ragModel: draftModelConfig.rag.provider === 'openai-compatible' ? draftModelConfig.rag.model : undefined,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }

    setDraftModelConfig((prev) => {
      const exists = prev.onlineProfiles.some((item) => item.id === profileId)
      return {
        ...prev,
        activeOnlineProfileId: profileId,
        onlineProfiles: exists
          ? prev.onlineProfiles.map((item) => (item.id === profileId ? nextProfile : item))
          : [nextProfile, ...prev.onlineProfiles],
      }
    })

    setApiTestState({
      status: 'idle',
      message: `预设“${profileName}”已加入待保存列表。`,
      models: apiTestState.models,
      latencyMs: apiTestState.latencyMs,
      balanceInfo: apiTestState.balanceInfo,
      testedAt: apiTestState.testedAt,
    })
  }, [draftModelConfig, apiTestState])

  const handleDeleteOnlineProfile = useCallback((profileId: string) => {
    setDraftModelConfig((prev) => ({
      ...prev,
      onlineProfiles: prev.onlineProfiles.filter((item) => item.id !== profileId),
      activeOnlineProfileId:
        prev.activeOnlineProfileId === profileId ? null : prev.activeOnlineProfileId,
    }))
  }, [])

  const handleResetOnlineDraft = useCallback(() => {
    setDraftModelConfig((prev) => ({
      ...prev,
      activeOnlineProfileId: null,
      online: {
        name: '',
        provider: 'OpenAI',
        baseUrl: onlineProviderPresets['OpenAI'],
        apiKey: '',
      },
    }))
  }, [])

  const updateDraftSkill = useCallback((skillId: string, patch: Partial<SkillConfig>) => {
    setSkillEditorDraft((prev) =>
      prev?.id === skillId
        ? {
            ...prev,
            ...patch,
            updatedAt: Date.now(),
          }
        : prev
    )
  }, [])

  const handleAddSkill = useCallback(() => {
    const nextSkill = createEmptySkill()
    setSkillEditorDraft(nextSkill)
    setSkillEditorMode('new')
    setSkillEditorSessionId(uuidv4())
    setActiveSkillId(nextSkill.id)
  }, [])

  const handleSelectSkill = useCallback((skill: SkillConfig) => {
    setActiveSkillId(skill.id)
    setSkillEditorDraft({ ...skill, keywords: [...skill.keywords] })
    setSkillEditorMode('edit')
    setSkillEditorSessionId(uuidv4())
  }, [])

  const handleDeleteSkill = useCallback(async (skillId: string) => {
    if (skillEditorMode === 'new' && skillEditorDraft?.id === skillId) {
      setSkillEditorDraft(null)
      setSkillEditorMode(null)
      setSkillEditorSessionId(uuidv4())
      setActiveSkillId(draftSkills[0]?.id ?? null)
      return
    }

    const nextSkills = draftSkills.filter((skill) => skill.id !== skillId)
    const savedSkills = await window.electronAPI.saveSkills(normalizeDraftSkills(nextSkills))
    setDraftSkills(savedSkills)
    const nextActive = savedSkills[0] ?? null
    setActiveSkillId(nextActive?.id ?? null)
    setSkillEditorDraft(nextActive ? { ...nextActive, keywords: [...nextActive.keywords] } : null)
    setSkillEditorMode(nextActive ? 'edit' : null)
    setSkillEditorSessionId(uuidv4())
  }, [draftSkills, skillEditorDraft, skillEditorMode])

  const handleAddAgent = useCallback(() => {
    const nextAgent = createEmptyAgent()
    setAgentEditorDraft(nextAgent)
    setAgentModalMode('new')
    setShowAgentModal(true)
  }, [])

  const handleSelectAgentDraft = useCallback((agent: AgentProfile) => {
    if (isLockedAgent(agent)) {
      return
    }
    setAgentEditorDraft(cloneAgent(agent))
    setAgentModalMode('edit')
    setShowAgentModal(true)
  }, [cloneAgent])

  const handleSaveAgent = useCallback(async () => {
    if (!agentEditorDraft) return
    if (isLockedAgent(agentEditorDraft)) {
      window.alert('内置通用智能体不允许修改')
      return
    }
    if (!agentEditorDraft.name.trim()) {
      window.alert('请先填写智能体名称')
      return
    }
    const saved = await persistAgent({
      ...agentEditorDraft,
      name: agentEditorDraft.name.trim(),
      description: agentEditorDraft.description.trim(),
      systemPrompt: agentEditorDraft.systemPrompt.trim(),
    })
    setAgentEditorDraft(cloneAgent(saved))
    setShowAgentModal(false)
  }, [agentEditorDraft, cloneAgent, persistAgent])

  const handleDeleteAgent = useCallback(async (agentId: string) => {
    const target = agents.find((agent) => agent.id === agentId)
    if (target && isLockedAgent(target)) {
      window.alert('内置通用智能体不允许删除')
      return
    }
    const ok = await window.electronAPI.agents.delete(agentId)
    if (!ok) return
    setAgents((prev) => prev.filter((agent) => agent.id !== agentId))
    setConversations((prev) => prev.map((conv) => conv.agentProfileId === agentId ? { ...conv, agentProfileId: null } : conv))
    if (pendingAgentId === agentId) {
      setPendingAgentId(null)
    }
    setAgentEditorDraft(null)
    setShowAgentModal(false)
  }, [agents, pendingAgentId])

  useEffect(() => {
    if (!activeAgentMenuId) return

    const handlePointerDown = () => {
      setActiveAgentMenuId(null)
    }

    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [activeAgentMenuId])

  const handleStartAgentChat = useCallback((agentId: string) => {
    setPendingAgentId(agentId === GENERAL_AGENT_ID ? null : agentId)
    setActiveId(null)
    setCurrentView('chat')
    setRagContextId(uuidv4())
    window.electronAPI.storage.setActive(null)
  }, [])

  const handleOpenModelConfig = useCallback(async (
    initialTab: 'models' | 'wechat' | 'skills' | 'tools' | 'diagnostics' = 'models',
  ) => {
    await refreshModelConfig()
    setSettingsTab(initialTab)
    setShowModelConfig(true)
  }, [refreshModelConfig])

  const handleCloseSettings = useCallback(() => {
    setShowModelConfig(false)
  }, [])

  const readSkillEditorDraft = useCallback((): SkillConfig | null => {
    if (!skillEditorDraft) return null
    const form = skillFormRef.current
    if (!form) return skillEditorDraft
    const formData = new FormData(form)
    return {
      ...skillEditorDraft,
      name: String(formData.get('name') ?? skillEditorDraft.name),
      description: String(formData.get('description') ?? skillEditorDraft.description),
      systemPrompt: String(formData.get('systemPrompt') ?? skillEditorDraft.systemPrompt),
      keywords: parseSkillKeywords(String(formData.get('keywords') ?? '')),
      priority: Number(formData.get('priority') ?? skillEditorDraft.priority) || 0,
      preferredScene: 'auto',
      updatedAt: Date.now(),
    }
  }, [skillEditorDraft])

  const handleSaveSkills = useCallback(async () => {
    const currentDraft = readSkillEditorDraft()
    if (!currentDraft) return

    if (!currentDraft.name.trim()) {
      window.alert('请先填写技能名称')
      return
    }

    if (!currentDraft.systemPrompt.trim()) {
      window.alert('请先填写自定义提示词')
      return
    }

    const duplicateName = draftSkills.find(
      (skill) =>
        skill.id !== currentDraft.id &&
        skill.name.trim() === currentDraft.name.trim(),
    )
    if (duplicateName) {
      window.alert('技能名称不能重复')
      return
    }

    const skillsToSave =
      skillEditorMode === 'new'
        ? [currentDraft, ...draftSkills]
        : draftSkills.map((skill) =>
            skill.id === currentDraft.id ? currentDraft : skill,
          )
    const savedSkills = await window.electronAPI.saveSkills(normalizeDraftSkills(skillsToSave))
    setDraftSkills(savedSkills)
    const savedActive =
      savedSkills.find((skill) => skill.id === currentDraft.id) ?? savedSkills[0] ?? null
    setActiveSkillId(savedActive?.id ?? null)
    setSkillEditorDraft(savedActive ? { ...savedActive, keywords: [...savedActive.keywords] } : null)
    setSkillEditorMode(savedActive ? 'edit' : null)
    setSkillEditorSessionId(uuidv4())
  }, [draftSkills, readSkillEditorDraft, skillEditorMode])

  const handleInlineRouteUpdate = useCallback(
    async (_key: 'chat' | 'agent' | 'rag', patch: Partial<RouteModelConfig>) => {
      const nextConfig: ModelRouteConfig = {
        ...modelConfig,
        chat: {
          ...modelConfig.chat,
          ...patch,
        },
        agent: {
          ...modelConfig.agent,
          ...patch,
        },
        rag: {
          ...modelConfig.rag,
          ...patch,
        },
      }

      setModelConfig(nextConfig)
      setDraftModelConfig(nextConfig)
      await window.electronAPI.saveModelConfig(toSettingsPayload(nextConfig))
    },
    [modelConfig]
  )

  const handleInlineApplyOnlineProfile = useCallback(
    async (profileId: string) => {
      const profile = modelConfig.onlineProfiles.find((item) => item.id === profileId)
      if (!profile) return

      const nextConfig: ModelRouteConfig = {
        ...modelConfig,
        activeOnlineProfileId: profile.id,
        online: {
          name: profile.name,
          provider: profile.provider,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
        },
        chat: {
          provider: 'openai-compatible',
          model:
            profile.chatModel ||
            profile.agentModel ||
            profile.ragModel ||
            modelConfig.chat.model,
        },
        agent: {
          provider: 'openai-compatible',
          model:
            profile.chatModel ||
            profile.agentModel ||
            profile.ragModel ||
            modelConfig.chat.model,
        },
        rag: {
          provider: 'openai-compatible',
          model:
            profile.chatModel ||
            profile.agentModel ||
            profile.ragModel ||
            modelConfig.chat.model,
        },
      }

      setModelConfig(nextConfig)
      setDraftModelConfig(nextConfig)
      await window.electronAPI.saveModelConfig(toSettingsPayload(nextConfig))
    },
    [modelConfig]
  )

  const handleSaveModelConfig = useCallback(async () => {
    const routes = ROUTE_ITEMS.map((item) => ({
      key: item.label,
      value: draftModelConfig[item.key],
    }))

    const missingModel = routes.find((route) => !route.value.model.trim())
    if (missingModel) {
      window.alert(`请先填写 ${missingModel.key} 的模型名称`)
      return
    }

    const usesOnline = routes.some((route) => route.value.provider === 'openai-compatible')
    if (usesOnline) {
      if (!draftModelConfig.online.baseUrl.trim()) {
        window.alert('请选择或填写在线模型的 Base URL')
        return
      }
      if (!draftModelConfig.online.apiKey.trim()) {
        window.alert('请输入在线模型 API Key')
        return
      }
    }

    const currentSkillDraft = readSkillEditorDraft()
    const skillsToSave = currentSkillDraft
      ? skillEditorMode === 'new'
        ? [currentSkillDraft, ...draftSkills]
        : draftSkills.map((skill) =>
            skill.id === currentSkillDraft.id ? currentSkillDraft : skill,
          )
      : draftSkills

    const invalidSkill = skillsToSave.find((skill) => !skill.name.trim())
    if (invalidSkill) {
      setActiveSkillId(invalidSkill.id)
      window.alert('请先为每个技能填写名称')
      return
    }

    const invalidPrompt = skillsToSave.find((skill) => !skill.systemPrompt.trim())
    if (invalidPrompt) {
      setActiveSkillId(invalidPrompt.id)
      window.alert('请先为每个技能填写自定义提示词')
      return
    }

    const duplicateSkill = skillsToSave.find((skill, index) =>
      skillsToSave.findIndex((item) => item.name.trim() === skill.name.trim()) !== index
    )
    if (duplicateSkill) {
      setActiveSkillId(duplicateSkill.id)
      window.alert('技能名称不能重复')
      return
    }

    const normalizedSkills = normalizeDraftSkills(skillsToSave)

    const [savedConfig, savedSkills, savedWechatBot] = await Promise.all([
      window.electronAPI.saveModelConfig(toSettingsPayload(draftModelConfig)),
      window.electronAPI.saveSkills(normalizedSkills),
      window.electronAPI.saveWechatBotSettings(draftWechatBotConfig),
    ])

    const nextConfig = normalizeModelConfig(savedConfig)
    const nextWechatBotConfig = normalizeWechatBotConfig(savedWechatBot)
    setModelConfig(nextConfig)
    setDraftModelConfig(nextConfig)
    setWechatBotConfig(nextWechatBotConfig)
    setDraftWechatBotConfig(nextWechatBotConfig)
    setBotBindState((prev) => ({
      ...prev,
      status: nextWechatBotConfig.status ?? prev.status,
      qrcode: nextWechatBotConfig.qrcode,
      qrContent: nextWechatBotConfig.qrContent,
      token: nextWechatBotConfig.token,
      botId: nextWechatBotConfig.botId,
      userId: nextWechatBotConfig.userId,
      nickname: nextWechatBotConfig.nickname,
    }))
    setDraftSkills(savedSkills)
    setActiveSkillId((current) =>
      savedSkills.some((skill) => skill.id === current) ? current : (savedSkills[0]?.id ?? null)
    )
    const savedActive =
      savedSkills.find((skill) => skill.id === currentSkillDraft?.id) ?? savedSkills[0] ?? null
    setSkillEditorDraft(savedActive ? { ...savedActive, keywords: [...savedActive.keywords] } : null)
    setSkillEditorMode(savedActive ? 'edit' : null)
    setSkillEditorSessionId(uuidv4())
    setShowModelConfig(false)
  }, [draftModelConfig, draftSkills, draftWechatBotConfig, readSkillEditorDraft, skillEditorMode])

  const handleTestOnlineApi = useCallback(async () => {
    const testModel =
      [draftModelConfig.chat, draftModelConfig.agent, draftModelConfig.rag].find(
        (route) => route.provider === 'openai-compatible' && route.model.trim()
      )?.model || draftModelConfig.chat.model

    setApiTestState({
      status: 'testing',
      message: '正在测试在线 API 连通性...',
      models: [],
    })

    try {
      const result = await window.electronAPI.testOnlineApi(draftModelConfig.online, testModel)
      const fetchedModels = result.models ?? []
      setApiTestState({
        status: result.ok ? 'success' : 'error',
        message: result.message,
        models: fetchedModels,
        latencyMs: result.latencyMs,
        balanceInfo: result.balanceInfo,
        testedAt: result.testedAt,
      })
      // API Test 成功且有模型列表时，将其缓存到当前激活的预设中
      if (result.ok && fetchedModels.length > 0) {
        setDraftModelConfig((prev) => {
          const activeProfileId = prev.activeOnlineProfileId
          if (!activeProfileId) return prev
          return {
            ...prev,
            onlineProfiles: prev.onlineProfiles.map((p) =>
              p.id === activeProfileId ? { ...p, models: fetchedModels } : p
            ),
          }
        })
      }
    } catch (error) {
      setApiTestState({
        status: 'error',
        message: error instanceof Error ? error.message : 'API 测试失败',
        models: [],
        testedAt: Date.now(),
      })
    }
  }, [draftModelConfig])

  const handleRefreshWechatBotQr = useCallback(async () => {
    try {
      const result = await window.electronAPI.refreshWechatBotQr()
      setBotBindState({
        status: result.status,
        message: result.message,
        qrcode: result.qrcode,
        qrContent: result.qrContent,
        qrDataUrl: result.qrDataUrl,
        token: result.token,
        botId: result.botId,
        userId: result.userId,
        nickname: result.nickname,
        updatedAt: result.updatedAt,
      })
    } catch (error) {
      setBotBindState({
        status: 'error',
        message: error instanceof Error ? error.message : 'ClawBot 二维码刷新失败',
        updatedAt: Date.now(),
      })
    }
  }, [])

  const handleUnbindWechatBot = useCallback(async () => {
    const result = await window.electronAPI.unbindWechatBot()
    setDraftWechatBotConfig((prev) => ({
      ...prev,
      enabled: false,
      token: '',
      botId: undefined,
      userId: undefined,
      nickname: undefined,
      status: result.status,
      boundAt: undefined,
    }))
    setWechatBotConfig((prev) => ({
      ...prev,
      enabled: false,
      token: '',
      botId: undefined,
      userId: undefined,
      nickname: undefined,
      status: result.status,
      boundAt: undefined,
    }))
    setBotBindState({
      status: result.status,
      message: result.message,
      updatedAt: result.updatedAt,
    })
  }, [])

  const applyWechatBotStatus = useCallback((status: {
    status: WechatBotBindStatus
    message: string
    qrcode?: string
    qrContent?: string
    qrDataUrl?: string
    token?: string
    botId?: string
    userId?: string
    nickname?: string
    updatedAt: number
  }) => {
    setBotBindState({
      status: status.status,
      message: status.message,
      qrcode: status.qrcode,
      qrContent: status.qrContent,
      qrDataUrl: status.qrDataUrl,
      token: status.token,
      botId: status.botId,
      userId: status.userId,
      nickname: status.nickname,
      updatedAt: status.updatedAt,
    })

    if (status.status === 'bound') {
      setDraftWechatBotConfig((prev) => ({
        ...prev,
        enabled: true,
        token: status.token ?? prev.token,
        botId: status.botId,
        userId: status.userId,
        nickname: status.nickname,
        status: 'bound',
      }))
    }
  }, [])

  useEffect(() => {
    if (!showModelConfig || settingsTab !== 'wechat') return

    let disposed = false
    const syncStatus = async () => {
      const status = await window.electronAPI.getWechatBotStatus()
      if (disposed) return
      applyWechatBotStatus(status)
    }

    const enterWechatTab = async () => {
      const status = await window.electronAPI.getWechatBotStatus()
      if (disposed) return

      applyWechatBotStatus(status)

      if (status.status !== 'bound') {
        const refreshed = await window.electronAPI.refreshWechatBotQr()
        if (disposed) return
        applyWechatBotStatus(refreshed)
      }
    }

    void enterWechatTab()
    const timer = window.setInterval(() => void syncStatus(), 3000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [applyWechatBotStatus, showModelConfig, settingsTab])

  const selectableModels = models.filter((model) => !/embed/i.test(model))
  const hasEmbeddingModel = models.some((model) => /nomic-embed-text/i.test(model))
  const activeOnlineProfile =
    draftModelConfig.onlineProfiles.find(
      (item) => item.id === draftModelConfig.activeOnlineProfileId
    ) ?? null
  const onlineModelCandidates = Array.from(
    new Set(
      [
        // 优先使用当前激活预设中已缓存的模型列表（由 API Test 自动获取并持久化）
        ...(activeOnlineProfile?.models ?? providerModelPresets[draftModelConfig.online.provider] ?? []),
        // 本次 API Test 临时返回的模型（未保存预设时也能使用）
        ...apiTestState.models,
        // 各预设中手动保存的模型名
        ...draftModelConfig.onlineProfiles
          .filter((profile) => profile.provider === draftModelConfig.online.provider)
          .flatMap((profile) =>
            [profile.chatModel, profile.agentModel, profile.ragModel].filter(
              (model): model is string => Boolean(model)
            )
          ),
      ].filter((model): model is string => Boolean(model))
    )
  )
  const sortedDraftSkills = [...draftSkills].sort(
    (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt
  )
  const activeSkillDraft = skillEditorDraft

  const handlePickRagFiles = useCallback(async () => {
    setIsRagProcessing(true)
    setRagStatusText('正在准备上传并分析文档...')

    try {
      const uploaded = await window.electronAPI.rag.pickFiles()
      if (uploaded.length === 0) {
        setIsRagProcessing(false)
        setRagStatusText('')
        return
      }
      setRagContextId(uuidv4())
      setRagFiles((prev) => {
        const merged = new Map(prev.map((file) => [file.id, file]))
        uploaded.forEach((file) => merged.set(file.id, file))
        const nextFiles = [...merged.values()].sort((a, b) => b.uploadedAt - a.uploadedAt)
        ragFilesRef.current = nextFiles
        return nextFiles
      })
      setIsRagProcessing(false)
      setRagStatusText('文档分析完成，可以开始提问。')
    } catch (error) {
      const message = error instanceof Error ? error.message : '文档上传失败'
      setIsRagProcessing(false)
      setRagStatusText('')
      window.alert(message)
    }
  }, [])

  const handleRemoveRagFile = useCallback(async (id: string) => {
    try {
      const removed = await window.electronAPI.rag.remove(id)
      if (removed) {
        setRagContextId(uuidv4())
        setRagFiles((prev) => {
          const nextFiles = prev.filter((file) => file.id !== id)
          ragFilesRef.current = nextFiles
          return nextFiles
        })
      }
    } catch (error) {
      console.error('移除文档失败', error)
    }
  }, [])

  const appendToStreamingMessage = useCallback((convId: string, msgId: string, text: string) => {
    if (!text) return
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === msgId
                  ? { ...m, content: sanitizeAssistantContent(m.content + text) }
                  : m
              ),
            }
          : c
      )
    )
  }, [])

  const flushTypingStep = useCallback(
    (convId: string, msgId: string) => {
      const pending = tokenQueueRef.current[convId] ?? ''
      if (!pending) {
        const timer = typingTimerRef.current[convId]
        if (timer) {
          clearInterval(timer)
          typingTimerRef.current[convId] = null
        }
        return
      }

      // 队列积压时自动提速，避免看起来“卡在后面慢慢打”。
      const charsPerStep =
        pending.length > 240 ? 48 : pending.length > 120 ? 24 : pending.length > 60 ? 12 : 4
      const chunk = pending.slice(0, charsPerStep)
      tokenQueueRef.current[convId] = pending.slice(charsPerStep)
      appendToStreamingMessage(convId, msgId, chunk)
    },
    [appendToStreamingMessage]
  )

  const ensureTypingLoop = useCallback(
    (convId: string, msgId: string) => {
      if (typingTimerRef.current[convId]) return

      typingTimerRef.current[convId] = setInterval(() => {
        flushTypingStep(convId, msgId)
      }, 12)
    },
    [flushTypingStep]
  )

  const enqueueToken = useCallback(
    (convId: string, msgId: string, token: string) => {
      if (!token) return
      tokenQueueRef.current[convId] = (tokenQueueRef.current[convId] ?? '') + token
      ensureTypingLoop(convId, msgId)
    },
    [ensureTypingLoop]
  )

  const flushAllQueuedTokens = useCallback((convId: string, msgId: string) => {
    const rest = tokenQueueRef.current[convId] ?? ''
    if (!rest) return
    tokenQueueRef.current[convId] = ''
    appendToStreamingMessage(convId, msgId, rest)
  }, [appendToStreamingMessage])

  const resetTokenBuffer = useCallback((convId: string) => {
    tokenQueueRef.current[convId] = ''
    const timer = typingTimerRef.current[convId]
    if (timer) {
      clearInterval(timer)
      typingTimerRef.current[convId] = null
    }
  }, [])

  // 中断请求
  const handleAbort = useCallback(() => {
    window.electronAPI.abortChat(activeId)
  }, [activeId])

  const buildKnowledgeOptions = useCallback((agent: AgentProfile | null | undefined) => {
    if (agent) {
      return {
        kbIds: agent.knowledge.defaultKbIds,
        ragOnly: agent.knowledge.ragOnly,
        minScore: agent.knowledge.minScore,
        topK: agent.knowledge.topK,
        fallbackToChat: agent.knowledge.fallbackToChat,
        citationRequired: agent.knowledge.citationRequired,
      }
    }

    return {}
  }, [])

  const handleCopyMessage = useCallback(async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content || '')
    } catch (err) {
      console.error('复制失败', err)
    }
  }, [])

  const handleEditUserMessage = useCallback(
    (messageId: string, content: string) => {
      if (!activeId) return
      setConversations((prev) => {
        const updated = prev.map((c) => {
          if (c.id !== activeId) return c
          const nextTitle =
            c.messages.find((m) => m.role === 'user')?.id === messageId
              ? generateTitle(content)
              : c.title
          return {
            ...c,
            title: nextTitle,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, content } : m
            ),
            updatedAt: Date.now(),
          }
        })
        const updatedConv = updated.find((c) => c.id === activeId)
        if (updatedConv) persistConversation(updatedConv)
        return updated
      })
    },
    [activeId, persistConversation]
  )

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (!activeId) return
      setConversations((prev) => {
        const updated = prev.map((c) => {
          if (c.id !== activeId) return c
          const nextMessages = c.messages.filter((m) => m.id !== messageId)
          const firstUser = nextMessages.find((m) => m.role === 'user')
          return {
            ...c,
            title: firstUser ? generateTitle(firstUser.content) : '新对话',
            messages: nextMessages,
            updatedAt: Date.now(),
          }
        })
        const updatedConv = updated.find((c) => c.id === activeId)
        if (updatedConv) persistConversation(updatedConv)
        return updated
      })
    },
    [activeId, persistConversation]
  )

  const handleRegenerateMessage = useCallback(
    async (messageId: string) => {
      if (activeIsLoading || isRagProcessing || !activeId) return

      const convId = activeId
      const targetConv = conversations.find((c) => c.id === convId)
      if (!targetConv) return

      const aiIndex = targetConv.messages.findIndex(
        (m) => m.id === messageId && m.role === 'assistant'
      )
      if (aiIndex < 0) return

      let userIndex = -1
      for (let i = aiIndex - 1; i >= 0; i--) {
        if (targetConv.messages[i].role === 'user') {
          userIndex = i
          break
        }
      }
      if (userIndex < 0) return

      const userMsg = targetConv.messages[userIndex]
      const targetRagContextId = targetConv.messages[aiIndex].ragContextId
      const baseMessages = targetRagContextId
        ? targetConv.messages.filter(
            (m, idx) => idx <= userIndex && m.ragContextId === targetRagContextId
          )
        : targetConv.messages.slice(0, userIndex + 1)
      const history = baseMessages.slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      const aiMsgId = uuidv4()
      const responseStartedAt = Date.now()
      const nextAiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
        ragContextId: targetRagContextId,
      }

      resetTokenBuffer(convId)
      streamingMsgIdRef.current[convId] = aiMsgId
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                messages: [...baseMessages, nextAiMsg],
                updatedAt: Date.now(),
              }
            : c
        )
      )

      markConversationLoading(convId)

      const removeToken = window.electronAPI.onToken(({ conversationId, token }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        enqueueToken(convId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ conversationId, toolName, input }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolCalls: [...(m.toolCalls ?? []), { toolName, input }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeToolResult = window.electronAPI.onToolResult(({ conversationId, toolName, result }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolResults: [...(m.toolResults ?? []), { toolName, result }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeModelInfo = window.electronAPI.onModelInfo(({ conversationId, modelInfo }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, modelInfo } : m
                  ),
                }
              : c
          )
        )
      })

      let finalized = false
      const finalize = (errorUpdate?: Partial<Message>) => {
        if (finalized) return
        finalized = true
        flushAllQueuedTokens(convId, aiMsgId)
        const durationMs = Math.max(0, Date.now() - responseStartedAt)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, durationMs, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === convId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        clearConversationLoading(convId)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(({ conversationId, status }) => {
        if (conversationId !== convId) return
        finalize(status === 'aborted' ? { isStopped: true } : undefined)
      })
      const removeError = window.electronAPI.onError(({ conversationId, error }) =>
        conversationId === convId
          ? finalize({ content: `错误：${error}`, isError: true })
          : undefined
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeModelInfo()
        removeDone()
        removeError()
        resetTokenBuffer(convId)
        streamingMsgIdRef.current[convId] = null
      }

      try {
        await window.electronAPI.sendMessage(
          history,
          userMsg.content,
          convId,
          Boolean(activeConversationAgent?.models.forceAgent || activeConversationAgent?.mode !== 'general'),
          ragFilesRef.current.map((file) => file.id),
          buildKnowledgeOptions(activeConversationAgent),
        )
      } catch (error) {
        finalize({
          content: `错误：${error instanceof Error ? error.message : '发送失败'}`,
          isError: true,
        })
      }
    },
    [activeConversationAgent, activeIsLoading, buildKnowledgeOptions, isRagProcessing, activeId, conversations, persistConversation, enqueueToken, flushAllQueuedTokens, resetTokenBuffer, markConversationLoading, clearConversationLoading]
  )

  // 发送消息
  const handleSend = useCallback(
    async (text: string, mode: 'chat' | 'task') => {
      if (isRagProcessing) return

      let convId = activeId
      if (convId && isConversationLoading(convId)) return
      let targetConv = conversations.find((c) => c.id === convId)
      if (!convId) {
        const conv = createConversation(pendingAgent?.id ?? null)
        targetConv = conv
        setConversations((prev) => [conv, ...prev])
        setActiveId(conv.id)
        convId = conv.id
      }

      if (!convId || !targetConv) return

      if (mode === 'task') {
        const userMsg = createMessage('user', text)
        const isFirstMsg = targetConv.messages.length === 0
        const newTitle = isFirstMsg ? generateTitle(text) : targetConv.title

        try {
          const taskId = await window.electronAPI.task.create(text)
          const task = (await window.electronAPI.task.get(taskId)) ?? createPendingTaskSnapshot(taskId, text)
          const taskMessage: Message = {
            id: uuidv4(),
            role: 'assistant',
            content: getTaskMessageContent(task),
            task,
            modelInfo: TASK_MODEL_INFO,
          }
          const updatedConversation: Conversation = {
            ...targetConv,
            title: newTitle,
            messages: [...targetConv.messages, userMsg, taskMessage],
            updatedAt: Date.now(),
          }

          setConversations((prev) => prev.map((conversation) =>
            conversation.id === convId ? updatedConversation : conversation
          ))
          persistConversation(updatedConversation)
        } catch (error) {
          const errorText = error instanceof Error ? error.message : '任务创建失败'
          const errorMessage: Message = {
            id: uuidv4(),
            role: 'assistant',
            content: `错误：${errorText}`,
            isError: true,
            modelInfo: TASK_MODEL_INFO,
          }
          const updatedConversation: Conversation = {
            ...targetConv,
            title: newTitle,
            messages: [...targetConv.messages, userMsg, errorMessage],
            updatedAt: Date.now(),
          }

          setConversations((prev) => prev.map((conversation) =>
            conversation.id === convId ? updatedConversation : conversation
          ))
          persistConversation(updatedConversation)
        }

        return
      }

      const currentRagFiles = ragFilesRef.current
      const activeRagContextId = currentRagFiles.length > 0 ? ragContextId : undefined
      const userMsg: Message = {
        ...createMessage('user', text),
        ragContextId: activeRagContextId,
      }
      const aiMsgId = uuidv4()
      const responseStartedAt = Date.now()
      const aiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
        ragContextId: activeRagContextId,
      }

      resetTokenBuffer(convId)
      streamingMsgIdRef.current[convId] = aiMsgId

      const isFirstMsg = (targetConv?.messages.length ?? 0) === 0
      const newTitle = isFirstMsg ? generateTitle(text) : (targetConv?.title ?? '新对话')

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                title: newTitle,
                messages: [...c.messages, userMsg, aiMsg],
                updatedAt: Date.now(),
              }
            : c
        )
      )

      markConversationLoading(convId)

      const history = (targetConv?.messages ?? [])
        .filter((m) => (!activeRagContextId ? true : m.ragContextId === activeRagContextId))
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))

      const removeToken = window.electronAPI.onToken(({ conversationId, token }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        enqueueToken(convId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ conversationId, toolName, input }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolCalls: [...(m.toolCalls ?? []), { toolName, input }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeToolResult = window.electronAPI.onToolResult(({ conversationId, toolName, result }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolResults: [...(m.toolResults ?? []), { toolName, result }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeModelInfo = window.electronAPI.onModelInfo(({ conversationId, modelInfo }) => {
        if (conversationId !== convId) return
        if (streamingMsgIdRef.current[convId] !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, modelInfo } : m
                  ),
                }
              : c
          )
        )
      })

      let finalized = false
      const finalize = (errorUpdate?: Partial<Message>) => {
        if (finalized) return
        finalized = true
        flushAllQueuedTokens(convId, aiMsgId)
        const durationMs = Math.max(0, Date.now() - responseStartedAt)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, durationMs, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === convId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        clearConversationLoading(convId)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(({ conversationId, status }) => {
        if (conversationId !== convId) return
        finalize(status === 'aborted' ? { isStopped: true } : undefined)
      })

      const removeError = window.electronAPI.onError(({ conversationId, error }) =>
        conversationId === convId
          ? finalize({ content: `错误：${error}`, isError: true })
          : undefined
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeModelInfo()
        removeDone()
        removeError()
        resetTokenBuffer(convId)
        streamingMsgIdRef.current[convId] = null
      }

      try {
        await window.electronAPI.sendMessage(
          history,
          text,
          convId,
          Boolean(
            (targetConv?.agentProfileId
              ? agents.find((agent) => agent.id === targetConv?.agentProfileId)
              : pendingAgent)?.models.forceAgent ||
            (targetConv?.agentProfileId
              ? agents.find((agent) => agent.id === targetConv?.agentProfileId)
              : pendingAgent)?.mode !== 'general'
          ),
          currentRagFiles.map((file) => file.id),
          buildKnowledgeOptions(
            (targetConv?.agentProfileId
              ? agents.find((agent) => agent.id === targetConv?.agentProfileId)
              : pendingAgent) ?? null
          ),
        )
      } catch (error) {
        finalize({
          content: `错误：${error instanceof Error ? error.message : '发送失败'}`,
          isError: true,
        })
      }
    },
    [agents, buildKnowledgeOptions, isRagProcessing, activeId, conversations, ragContextId, pendingAgent, persistConversation, enqueueToken, flushAllQueuedTokens, resetTokenBuffer, isConversationLoading, markConversationLoading, clearConversationLoading]
  )

  return (
    <div className={styles.app}>
      <TitleBar />
      <Sidebar
        conversations={conversations}
        agents={agents.map((agent) => ({ id: agent.id, name: agent.name, avatar: agent.avatar }))}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onRename={handleRenameConversation}
        onOpenSettings={() => void handleOpenModelConfig()}
        currentView={currentView}
        onViewChange={setCurrentView}
        runningTaskCount={runningTaskCount}
        activeKbId={activeKbId}
        onSelectKb={(id) => {
          setActiveKbId(id)
          setCurrentView('kb')
        }}
      />
      <div className={styles.main}>
        {currentView === 'agents' ? (
          <div className={styles.agentPage}>
            <div className={styles.agentPageHeader}>
              <div>
                <h2 className={styles.agentPageTitle}>智能体中心</h2>
                <p className={styles.agentPageHint}>
                  在这里创建、配置并管理智能体。卡片上的“进入聊天”会以该智能体开始新的对话。
                </p>
              </div>
              <div className={styles.agentPageHeaderActions}>
                <button className={styles.agentPageHeaderBtn} onClick={() => handleAddAgent()}>
                  新建智能体
                </button>
              </div>
            </div>

            <div className={styles.agentWorkspace}>
              <div className={styles.agentCardGrid}>
                {agents.map((agent) => (
                  <div
                    key={agent.id}
                    className={styles.agentOverviewCard}
                  >
                    <div className={styles.agentOverviewTop}>
                      <span className={styles.agentOverviewAvatar}>{agent.avatar || agent.name.slice(0, 1)}</span>
                      <div className={styles.agentOverviewTopActions}>
                        <span className={styles.agentOverviewMode}>{getAgentModeLabel(agent.mode)}</span>
                        {!isLockedAgent(agent) && (
                          <div className={styles.agentCardMenuWrap}>
                            <button
                              type="button"
                              className={styles.agentCardMenuBtn}
                              onClick={(e) => {
                                e.stopPropagation()
                                setActiveAgentMenuId((prev) => prev === agent.id ? null : agent.id)
                              }}
                              title="更多操作"
                              aria-label="更多操作"
                            >
                              <span className={styles.agentCardMenuIcon} />
                            </button>
                            {activeAgentMenuId === agent.id && (
                              <div
                                className={styles.agentCardMenu}
                                onPointerDown={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  className={styles.agentCardMenuItem}
                                  onClick={() => {
                                    setActiveAgentMenuId(null)
                                    handleSelectAgentDraft(agent)
                                  }}
                                >
                                  编辑
                                </button>
                                <button
                                  type="button"
                                  className={`${styles.agentCardMenuItem} ${styles.agentCardMenuItemDanger}`}
                                  onClick={async () => {
                                    setActiveAgentMenuId(null)
                                    if (await confirm({ message: `确定删除智能体“${agent.name || '未命名智能体'}”吗？`, tone: 'danger' })) {
                                      void handleDeleteAgent(agent.id)
                                    }
                                  }}
                                >
                                  删除
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className={styles.agentOverviewName}>{agent.name}</div>
                    <div className={styles.agentOverviewDesc}>
                      {agent.description || '未填写智能体说明'}
                    </div>
                    <div className={styles.agentOverviewMeta}>
                      <span>{agent.knowledge.defaultKbIds.length} 个知识库</span>
                      <span>{agent.models.forceAgent ? '强 Agent' : '轻聊天'}</span>
                    </div>
                    <div className={styles.agentOverviewActions}>
                      <button className={styles.miniPrimaryBtn} onClick={() => handleStartAgentChat(agent.id)}>
                        进入聊天
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : currentView === 'kb' ? (
          <KnowledgeBasePanel
            activeKbId={activeKbId}
            onActiveKbIdChange={setActiveKbId}
          />
        ) : currentView === 'skills' ? (
          <SkillsPanel />
        ) : currentView === 'wechat' ? (
          <WechatBotPanel onOpenSettings={() => void handleOpenModelConfig('wechat')} />
        ) : (
          <>
            <div className={styles.topbar}>
              <div>
                <span className={styles.convTitle}>
                  {activeConversation?.title ?? '新对话'}
                </span>
                <div className={styles.agentPillRow}>
                  <span className={styles.chatModePill}>
                    {activeConversationAgent && !isLockedAgent(activeConversationAgent) ? '智能体对话' : '通用'}
                  </span>
                  {activeConversationAgent && !isLockedAgent(activeConversationAgent) && (
                    <span className={styles.agentPill}>
                      {activeConversationAgent.name}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <ChatArea
              messages={activeConversation?.messages ?? []}
              isLoading={activeIsLoading || (activeConversation !== null && !activeConversation.loaded)}
              onCopyMessage={handleCopyMessage}
              onEditUserMessage={handleEditUserMessage}
              onDeleteMessage={handleDeleteMessage}
              onRegenerateMessage={handleRegenerateMessage}
            />

            <InputBar
              onSend={handleSend}
              onAbort={handleAbort}
              isLoading={activeIsLoading}
              isRagProcessing={isRagProcessing}
              ragStatusText={ragStatusText}
              ragFiles={ragFiles}
              onPickFiles={handlePickRagFiles}
              onRemoveFile={handleRemoveRagFile}
              modelConfig={modelConfig}
              localModels={selectableModels}
              onlineModelCandidates={onlineModelCandidates}
              skills={draftSkills}
              agents={selectableAgents.map((agent) => ({ id: agent.id, name: agent.name }))}
              selectedAgentId={activeConversation?.agentProfileId ?? pendingAgent?.id ?? ''}
              canSelectAgent={!activeConversation || (activeConversation.loaded && activeConversation.messages.length === 0)}
              onSelectAgent={(agentId) => void handleSelectConversationAgent(agentId)}
              onUpdateRoute={handleInlineRouteUpdate}
              onApplyOnlineProfile={handleInlineApplyOnlineProfile}
            />
          </>
        )}
      </div>

      {showAgentModal && agentEditorDraft && (
        <div className={styles.modalOverlay}>
          <div className={styles.agentModal} onMouseDown={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>{agentModalMode === 'new' ? '新建智能体' : '编辑智能体'}</h3>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                onClick={() => setShowAgentModal(false)}
                aria-label="关闭"
                title="关闭"
              >
                ×
              </button>
            </div>

            <div className={styles.agentModalBody}>
              <div className={styles.fieldGrid}>
                <label className={styles.fieldItem}>
                  <span>名称</span>
                  <input
                    className={styles.fieldInput}
                    value={agentEditorDraft.name}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, name: e.target.value } : prev)}
                    placeholder="例如：产品助手 / 法务助手"
                  />
                </label>
                <div className={styles.fieldItem}>
                  <span className={styles.fieldLabelRow}>
                    <span>模式</span>
                    <div className={styles.infoPopoverWrap}>
                      <button
                        ref={agentModeInfoButtonRef}
                        type="button"
                        className={styles.infoIconBtn}
                        onClick={() => setAgentModeInfoOpen((prev) => !prev)}
                        aria-label="查看模式说明"
                        title="查看模式说明"
                      >
                        i
                      </button>
                    </div>
                  </span>
                  <select
                    className={styles.fieldSelect}
                    value={agentEditorDraft.mode}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, mode: e.target.value as AgentMode } : prev)}
                  >
                    <option value="domain">专业助手</option>
                    <option value="workflow">流程助手</option>
                    <option value="general">通用助手</option>
                  </select>
                  <div className={styles.fieldHint}>
                    当前模式：{currentAgentModeDescription.title}。{currentAgentModeDescription.description}
                    {currentAgentModeDescription.example}
                  </div>
                </div>
              </div>

              {agentModeInfoOpen && (
                <div
                  ref={agentModeInfoRef}
                  className={styles.infoPopover}
                  style={{
                    top: `${Math.max(16, agentModeInfoPosition.top)}px`,
                    left: `${Math.max(16, agentModeInfoPosition.left)}px`,
                  }}
                >
                  <div className={styles.infoPopoverTitle}>模式说明</div>
                  <div className={styles.infoPopoverText}>
                    专业助手：面向某个专业角色，回答更稳定、口径更统一。
                  </div>
                  <div className={styles.infoPopoverText}>
                    流程助手：面向一类固定任务，适合拆步骤、按阶段推进。
                  </div>
                  <div className={styles.infoPopoverText}>
                    通用助手：像默认助手一样处理日常问题，适用范围最广。
                  </div>
                </div>
              )}

              <label className={styles.fieldItem}>
                <span>描述</span>
                <input
                  className={styles.fieldInput}
                  value={agentEditorDraft.description}
                  onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, description: e.target.value } : prev)}
                  placeholder="一句话说明这个智能体擅长什么"
                />
              </label>

              <label className={styles.fieldItem}>
                <span>系统提示词</span>
                <textarea
                  className={styles.fieldTextarea}
                  rows={8}
                  value={agentEditorDraft.systemPrompt}
                  onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, systemPrompt: e.target.value } : prev)}
                  placeholder="定义该智能体的角色、边界和回答风格"
                />
              </label>

              <div className={styles.fieldGrid}>
                <label className={styles.fieldItem}>
                  <span>最小相关度</span>
                  <input
                    className={styles.fieldInput}
                    type="number"
                    min={0.1}
                    max={0.9}
                    step={0.05}
                    value={agentEditorDraft.knowledge.minScore}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, knowledge: { ...prev.knowledge, minScore: Number(e.target.value) || 0.6 } } : prev)}
                  />
                </label>
                <label className={styles.fieldItem}>
                  <span>Top K</span>
                  <input
                    className={styles.fieldInput}
                    type="number"
                    min={1}
                    max={20}
                    step={1}
                    value={agentEditorDraft.knowledge.topK}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, knowledge: { ...prev.knowledge, topK: Number(e.target.value) || 6 } } : prev)}
                  />
                </label>
              </div>

              <div className={styles.agentToggleGrid}>
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={agentEditorDraft.knowledge.ragOnly}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, knowledge: { ...prev.knowledge, ragOnly: e.target.checked } } : prev)}
                  />
                  <span>仅基于知识库回答</span>
                </label>
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={agentEditorDraft.knowledge.fallbackToChat}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, knowledge: { ...prev.knowledge, fallbackToChat: e.target.checked } } : prev)}
                  />
                  <span>无命中时回退普通回答</span>
                </label>
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={agentEditorDraft.knowledge.citationRequired}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, knowledge: { ...prev.knowledge, citationRequired: e.target.checked } } : prev)}
                  />
                  <span>要求引用证据</span>
                </label>
                <label className={styles.toggleRow}>
                  <input
                    type="checkbox"
                    checked={agentEditorDraft.models.forceAgent}
                    onChange={(e) => setAgentEditorDraft((prev) => prev ? { ...prev, models: { ...prev.models, forceAgent: e.target.checked } } : prev)}
                  />
                  <span>默认走 Agent 路由</span>
                </label>
              </div>

              <div className={styles.agentKbSection}>
                <div className={styles.agentKbSectionHeader}>
                  <div>
                    <div className={styles.modalLabel}>关联知识库</div>
                    <div className={styles.agentKbSectionHint}>
                      可为当前智能体选择一个或多个知识库，聊天时会优先使用这里的绑定配置。
                    </div>
                  </div>
                  <span className={styles.agentKbCount}>
                    已选 {agentEditorDraft.knowledge.defaultKbIds.length} 个
                  </span>
                </div>

                {knowledgeBases.length === 0 ? (
                  <div className={styles.agentKbEmpty}>
                    <div className={styles.emptyHint}>当前还没有知识库，先创建知识库后再绑定到智能体。</div>
                    <button
                      className={styles.miniBtn}
                      onClick={() => {
                        setShowAgentModal(false)
                        setCurrentView('kb')
                      }}
                    >
                      前往知识库
                    </button>
                  </div>
                ) : (
                  <div className={styles.agentKbPicker} ref={agentKbPickerRef}>
                    <button
                      type="button"
                      className={`${styles.agentKbTrigger} ${agentKbPickerOpen ? styles.agentKbTriggerOpen : ''}`}
                      onClick={() => setAgentKbPickerOpen((prev) => !prev)}
                    >
                      <span className={styles.agentKbTriggerText}>
                        {selectedKnowledgeBases.length > 0
                          ? selectedKnowledgeBases.map((kb) => kb.name).join('、')
                          : '请选择知识库'}
                      </span>
                      <span className={styles.agentKbTriggerArrow}>{agentKbPickerOpen ? '▴' : '▾'}</span>
                    </button>

                    {agentKbPickerOpen && (
                      <div className={styles.agentKbDropdown}>
                        <div className={styles.agentKbSearchWrap}>
                          <input
                            className={styles.agentKbSearchInput}
                            value={agentKbSearch}
                            onChange={(e) => setAgentKbSearch(e.target.value)}
                            placeholder="搜索知识库名称或描述"
                          />
                        </div>
                        <div className={styles.agentKbDropdownList}>
                          {filteredKnowledgeBases.length === 0 && (
                            <div className={styles.agentKbNoResult}>没有匹配的知识库</div>
                          )}
                          {filteredKnowledgeBases.map((kb) => {
                            const selected = agentEditorDraft.knowledge.defaultKbIds.includes(kb.id)
                            return (
                              <label key={kb.id} className={styles.agentKbOption}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={() => toggleDraftKnowledgeBase(kb.id)}
                                />
                                <div className={styles.agentKbOptionBody}>
                                  <div className={styles.agentKbOptionTop}>
                                    <span className={styles.agentKbOptionName}>{kb.name}</span>
                                    <span className={styles.agentKbOptionMeta}>
                                      {kb.docCount} 文档 / {kb.chunkCount} 片段
                                    </span>
                                  </div>
                                  <div className={styles.agentKbOptionDesc}>
                                    {kb.description || '未填写知识库说明'}
                                  </div>
                                </div>
                              </label>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className={styles.agentModalFooter}>
              <div className={styles.profileActions} style={{ marginLeft: 'auto' }}>
                <button className={styles.miniBtn} onClick={() => setShowAgentModal(false)}>
                  取消
                </button>
                <button className={styles.miniPrimaryBtn} onClick={() => void handleSaveAgent()}>
                  保存智能体
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showModelConfig && (
        <div
          className={styles.modalOverlay}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) handleCloseSettings()
          }}
        >
          <div className={styles.modal} onMouseDown={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>设置</h3>
              </div>
              <button
                type="button"
                className={styles.modalClose}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={handleCloseSettings}
                aria-label="关闭设置"
                title="关闭"
              >
                ×
              </button>
            </div>

            <div className={styles.modalLayout}>
              <aside className={styles.settingsSidebar}>
                <div className={styles.settingsNavTitle}>设置菜单</div>
                <button
                  type="button"
                  className={`${styles.settingsNavItem} ${settingsTab === 'models' ? styles.settingsNavItemActive : ''}`}
                  onClick={() => setSettingsTab('models')}
                >
                  <span className={styles.settingsNavIcon}>◉</span>
                  <span className={styles.settingsNavText}>
                    <span>在线预设</span>
                    <small>模型、API 与 RAG</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.settingsNavItem} ${settingsTab === 'wechat' ? styles.settingsNavItemActive : ''}`}
                  onClick={() => setSettingsTab('wechat')}
                >
                  <span className={styles.settingsNavIcon}>微</span>
                  <span className={styles.settingsNavText}>
                    <span>微信 Bot</span>
                    <small>群机器人绑定</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.settingsNavItem} ${settingsTab === 'tools' ? styles.settingsNavItemActive : ''}`}
                  onClick={() => setSettingsTab('tools')}
                >
                  <span className={styles.settingsNavIcon}>◇</span>
                  <span className={styles.settingsNavText}>
                    <span>工具权限</span>
                    <small>风险等级与确认</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`${styles.settingsNavItem} ${settingsTab === 'diagnostics' ? styles.settingsNavItemActive : ''}`}
                  onClick={() => setSettingsTab('diagnostics')}
                >
                  <span className={styles.settingsNavIcon}>⌁</span>
                  <span className={styles.settingsNavText}>
                    <span>日志诊断</span>
                    <small>Trace 与运行状态</small>
                  </span>
                </button>
              </aside>

              <div className={styles.modalContent}>
                <div className={styles.modalBody}>
            {settingsTab === 'models' && (
              <>
            <div className={styles.modalSection}>
              <div className={styles.modalLabel}>模型切换已移到输入框</div>
              <div className={styles.hintCard}>
                聊天页底部现在只保留一个全局模型选择器。聊天、复杂任务和 RAG 会统一使用同一套模型配置，这里不再展示任何场景路由配置卡。
              </div>
            </div>

            <div className={styles.modalSection}>
              <div className={styles.modalLabel}>本地 Ollama 模型</div>
              <div className={styles.modelList}>
                {models.length === 0 ? (
                  <span className={styles.emptyHint}>未检测到 Ollama 模型</span>
                ) : (
                  models.map((model) => (
                    <span
                      key={model}
                      className={`${styles.modelTag} ${/embed/i.test(model) ? styles.embedTag : ''}`}
                    >
                      {model}
                    </span>
                  ))
                )}
              </div>
            </div>

            <div className={styles.modalSection}>
              <div className={styles.modalLabel}>在线 API / 第三方模型</div>

              <div className={styles.profileToolbar}>
                <select
                  className={styles.fieldSelect}
                  value={draftModelConfig.activeOnlineProfileId ?? ''}
                  onChange={(e) => {
                    if (!e.target.value) {
                      handleResetOnlineDraft()
                      return
                    }
                    applyOnlineProfile(e.target.value)
                  }}
                >
                  <option value="">一键切换已保存预设...</option>
                  {draftModelConfig.onlineProfiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {profile.provider}
                    </option>
                  ))}
                </select>

                <button className={styles.secondaryBtn} onClick={() => handleResetOnlineDraft()}>
                  新建预设
                </button>
                <button className={styles.secondaryBtn} onClick={() => handleSaveOnlineProfile()}>
                  {activeOnlineProfile ? '更新预设' : '保存为预设'}
                </button>
              </div>

              <div className={styles.fieldGrid}>
                <label className={styles.fieldItem}>
                  <span>预设名称</span>
                  <input
                    className={styles.fieldInput}
                    value={draftModelConfig.online.name}
                    onChange={(e) => updateOnlineConfig({ name: e.target.value })}
                    placeholder="例如：我的 DeepSeek / 公司 OpenAI"
                  />
                </label>

                <label className={styles.fieldItem}>
                  <span>服务商预设</span>
                  <select
                    className={styles.fieldSelect}
                    value={draftModelConfig.online.provider}
                    onChange={(e) => {
                      const provider = e.target.value
                      updateOnlineConfig({
                        provider,
                        baseUrl:
                          provider === 'Custom'
                            ? draftModelConfig.online.baseUrl
                            : (onlineProviderPresets[provider] ?? draftModelConfig.online.baseUrl),
                      })
                    }}
                  >
                    {Object.keys(onlineProviderPresets).map((provider) => (
                      <option key={provider} value={provider}>
                        {provider}
                      </option>
                    ))}
                  </select>
                </label>

                <label className={styles.fieldItem}>
                  <span>Base URL</span>
                  <input
                    className={styles.fieldInput}
                    value={draftModelConfig.online.baseUrl}
                    onChange={(e) => updateOnlineConfig({ baseUrl: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                  />
                </label>

                <label className={styles.fieldItem}>
                  <span>API Key</span>
                  <input
                    className={styles.fieldInput}
                    type="password"
                    value={draftModelConfig.online.apiKey}
                    onChange={(e) => updateOnlineConfig({ apiKey: e.target.value })}
                    placeholder="sk-..."
                  />
                </label>
              </div>

              <div className={styles.hintCard}>
                支持 OpenAI、DeepSeek、Moonshot、SiliconFlow、智谱 AI、OpenRouter 等兼容 OpenAI Chat Completions 的服务；创建并保存预设后，可在聊天输入框上方直接切换全局在线模型。密钥仅保存在本机。
              </div>

              {draftModelConfig.onlineProfiles.length > 0 && (
                <div className={styles.profileList}>
                  {draftModelConfig.onlineProfiles.map((profile) => (
                    <div
                      key={profile.id}
                      className={`${styles.profileCard} ${
                        profile.id === draftModelConfig.activeOnlineProfileId
                          ? styles.profileCardActive
                          : ''
                      }`}
                    >
                      <div className={styles.profileHeader}>
                        <div>
                          <div className={styles.profileName}>{profile.name}</div>
                          <div className={styles.profileMeta}>
                            {profile.provider} · {profile.baseUrl}
                          </div>
                        </div>
                        <div className={styles.profileActions}>
                          <button className={styles.miniBtn} onClick={() => applyOnlineProfile(profile.id)}>
                            应用
                          </button>
                          <button
                            className={`${styles.miniBtn} ${styles.dangerBtn}`}
                                onClick={async () => {
                                  if (await confirm({ message: `确定删除预设“${profile.name}”吗？`, tone: 'danger' })) {
                                    handleDeleteOnlineProfile(profile.id)
                                  }
                                }}
                          >
                            删除
                          </button>
                        </div>
                      </div>

                      <div className={styles.modelList}>
                        {profile.chatModel && <span className={styles.modelTag}>Chat: {profile.chatModel}</span>}
                        {profile.agentModel && <span className={styles.modelTag}>Agent: {profile.agentModel}</span>}
                        {profile.ragModel && <span className={styles.modelTag}>RAG: {profile.ragModel}</span>}
                        <span className={styles.modelTag}>Key: {maskApiKey(profile.apiKey)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className={styles.testRow}>
                <button
                  className={styles.secondaryBtn}
                  onClick={() => void handleTestOnlineApi()}
                  disabled={apiTestState.status === 'testing'}
                >
                  {apiTestState.status === 'testing' ? '测试中...' : 'API Test'}
                </button>

                {apiTestState.message && (
                  <span
                    className={`${styles.statusNote} ${
                      apiTestState.status === 'success'
                        ? styles.statusSuccess
                        : apiTestState.status === 'error'
                          ? styles.statusError
                          : ''
                    }`}
                  >
                    {apiTestState.message}
                  </span>
                )}
              </div>

              {(apiTestState.latencyMs || apiTestState.balanceInfo || apiTestState.testedAt) && (
                <div className={styles.metricsGrid}>
                  <div className={styles.metricCard}>
                    <div className={styles.metricLabel}>延迟</div>
                    <div className={styles.metricValue}>
                      {apiTestState.latencyMs ? `${apiTestState.latencyMs} ms` : '—'}
                    </div>
                  </div>
                  <div className={styles.metricCard}>
                    <div className={styles.metricLabel}>余额</div>
                    <div className={styles.metricValue}>{apiTestState.balanceInfo || '未提供'}</div>
                  </div>
                  <div className={styles.metricCard}>
                    <div className={styles.metricLabel}>测试时间</div>
                    <div className={styles.metricValue}>
                      {apiTestState.testedAt
                        ? new Date(apiTestState.testedAt).toLocaleTimeString('zh-CN', {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })
                        : '—'}
                    </div>
                  </div>
                </div>
              )}

              {onlineModelCandidates.length > 0 && (
                <div className={styles.modelList}>
                  {onlineModelCandidates.map((model) => (
                    <span key={model} className={styles.modelTag}>
                      {model}
                    </span>
                  ))}
                </div>
              )}

              <datalist id="online-model-suggestions">
                {onlineModelCandidates.map((model) => (
                  <option key={`online-${model}`} value={model} />
                ))}
              </datalist>
            </div>

              </>
            )}

            {settingsTab === 'skills' && (
              <div className={styles.modalSection}>
                <div className={styles.modalLabel}>Skills 技能中心</div>

              <div className={styles.profileToolbar}>
                <button className={styles.secondaryBtn} onClick={() => handleAddSkill()}>
                  新建技能
                </button>
                <span className={styles.statusNote}>
                  技能只保存在本机；支持关键词自动触发，也支持在提问里输入 `#技能名` 显式指定。
                </span>
              </div>

              <div className={styles.skillsLayout}>
                <div className={styles.skillList}>
                  {sortedDraftSkills.length === 0 ? (
                    <div className={styles.emptyHint}>还没有创建技能，可先添加一个本地技能模板。</div>
                  ) : (
                    sortedDraftSkills.map((skill) => (
                      <button
                        key={skill.id}
                        className={`${styles.skillCard} ${
                          skill.id === activeSkillId ? styles.skillCardActive : ''
                        }`}
                        onClick={() => handleSelectSkill(skill)}
                      >
                        <div className={styles.skillCardHeader}>
                          <span className={styles.skillCardName}>{skill.name || '未命名技能'}</span>
                          <span
                            className={`${styles.skillState} ${
                              skill.enabled ? styles.skillEnabled : styles.skillDisabled
                            }`}
                          >
                            {skill.enabled ? '已启用' : '已停用'}
                          </span>
                        </div>
                        <div className={styles.skillCardDesc}>
                          {skill.description || '未填写技能说明'}
                        </div>
                        <div className={styles.skillCardMeta}>
                          <span>优先级 {skill.priority}</span>
                        </div>
                        {skill.keywords.length > 0 && (
                          <div className={styles.modelList}>
                            {skill.keywords.slice(0, 4).map((keyword) => (
                              <span key={`${skill.id}-${keyword}`} className={styles.modelTag}>
                                {keyword}
                              </span>
                            ))}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>

                <div className={styles.skillEditor}>
                  {activeSkillDraft ? (
                    <form
                      ref={skillFormRef}
                      key={skillEditorSessionId}
                      className={styles.skillEditorForm}
                      onSubmit={(e) => {
                        e.preventDefault()
                        void handleSaveSkills()
                      }}
                    >
                      <div className={styles.skillEditorHeader}>
                        <div>
                          <div className={styles.routeTitle}>{activeSkillDraft.name || '未命名技能'}</div>
                          <div className={styles.routeHint}>
                            {skillEditorMode === 'new'
                              ? '新技能尚未保存，保存后会出现在左侧列表。'
                              : '技能只保存在当前设备本地，可影响提示词和自动路由策略。'}
                          </div>
                        </div>
                        <div className={styles.profileActions}>
                          <button
                            type="submit"
                            className={styles.miniPrimaryBtn}
                          >
                            保存
                          </button>
                          <button
                            type="button"
                            className={styles.miniBtn}
                            onClick={() =>
                              updateDraftSkill(activeSkillDraft.id, {
                                enabled: !activeSkillDraft.enabled,
                              })
                            }
                          >
                            {activeSkillDraft.enabled ? '停用' : '启用'}
                          </button>
                          <button
                            type="button"
                            className={`${styles.miniBtn} ${styles.dangerBtn}`}
                              onClick={async () => {
                                if (await confirm({ message: `确定删除技能“${activeSkillDraft.name || '未命名技能'}”吗？`, tone: 'danger' })) {
                                  void handleDeleteSkill(activeSkillDraft.id)
                                }
                              }}
                          >
                            删除
                          </button>
                        </div>
                      </div>

                      <div className={styles.fieldGrid}>
                        <label className={styles.fieldItem}>
                          <span>技能名称</span>
                          <input
                            className={styles.fieldInput}
                            name="name"
                            defaultValue={activeSkillDraft.name}
                            placeholder="例如：写作助手 / 前端代码审查"
                          />
                        </label>

                        <label className={styles.fieldItem}>
                          <span>优先级（0-100）</span>
                          <input
                            className={styles.fieldInput}
                            type="number"
                            min={0}
                            max={100}
                            name="priority"
                            defaultValue={activeSkillDraft.priority}
                          />
                        </label>

                        <label className={styles.fieldItem}>
                          <span>触发关键词</span>
                          <input
                            className={styles.fieldInput}
                            name="keywords"
                            defaultValue={formatSkillKeywords(activeSkillDraft.keywords)}
                            placeholder="例如：润色, 摘要, 邮件"
                          />
                        </label>
                      </div>

                      <label className={styles.fieldItem}>
                        <span>技能说明</span>
                        <input
                          className={styles.fieldInput}
                          name="description"
                          defaultValue={activeSkillDraft.description}
                          placeholder="简要说明这个技能适合解决什么任务"
                        />
                      </label>

                      <label className={styles.fieldItem}>
                        <span>自定义提示词</span>
                        <textarea
                          className={styles.fieldTextarea}
                          name="systemPrompt"
                          defaultValue={activeSkillDraft.systemPrompt}
                          placeholder="例如：你是一名资深前端架构师，回答时先给结论，再给可执行步骤与代码示例。"
                        />
                      </label>
                    </form>
                  ) : (
                    <div className={styles.emptyHint}>从左侧选择一个技能，或先新建技能。</div>
                  )}
                </div>
              </div>
              </div>
            )}

            {settingsTab === 'models' && (
              <div className={styles.modalSection}>
                <div className={styles.modalLabel}>RAG 检索模型</div>
                <div className={styles.embedNote}>
                  向量检索固定使用 `nomic-embed-text:latest`。
                  {hasEmbeddingModel ? ' 当前已安装。' : ' 当前未检测到，请先用 `ollama pull nomic-embed-text` 安装。'}
                </div>
              </div>
            )}

            {settingsTab === 'wechat' && (
              <>
                <div className={styles.modalSection}>
                  <div className={styles.modalLabel}>微信 ClawBot 绑定</div>
                  <div className={styles.hintCard}>
                    使用微信「设置 - 插件 - ClawBot」扫描下方二维码完成绑定。这里不是个人微信登录页，二维码来自微信 ClawBot 绑定服务。
                    绑定后请从左侧“微信ClawBot”入口调试对话和复制 OpenClaw Gateway 配置。
                  </div>
                </div>

                <div className={styles.modalSection}>
                  <div className={styles.modalLabel}>绑定二维码</div>
                  <div className={styles.profileToolbar}>
                    <button
                      className={styles.secondaryBtn}
                      onClick={() => void handleRefreshWechatBotQr()}
                    >
                      刷新二维码
                    </button>
                    <button
                      className={`${styles.secondaryBtn} ${styles.dangerBtn}`}
                      onClick={() => void handleUnbindWechatBot()}
                    >
                      解绑
                    </button>
                    {botBindState.message && (
                      <span
                        className={`${styles.statusNote} ${
                          botBindState.status === 'bound'
                            ? styles.statusSuccess
                            : botBindState.status === 'error'
                              ? styles.statusError
                              : ''
                        }`}
                      >
                        {botBindState.message}
                      </span>
                    )}
                  </div>

                  {botBindState.qrDataUrl ? (
                    <div className={styles.qrWrap}>
                      <img className={styles.qrImage} src={botBindState.qrDataUrl} alt="微信 ClawBot 绑定二维码" />
                      <div className={styles.qrMeta}>
                        <div>请使用微信 ClawBot 扫码完成绑定。</div>
                        <div>绑定状态：{botBindState.status === 'bound' ? '已绑定' : '等待扫码'}</div>
                      </div>
                    </div>
                  ) : (
                    <div className={styles.emptyHint}>点击“刷新二维码”获取微信 ClawBot 绑定二维码。</div>
                  )}

                  {(botBindState.updatedAt || draftWechatBotConfig.updatedAt) && (
                    <div className={styles.metricsGrid}>
                      <div className={styles.metricCard}>
                        <div className={styles.metricLabel}>更新时间</div>
                        <div className={styles.metricValue}>
                          {new Date(botBindState.updatedAt ?? draftWechatBotConfig.updatedAt ?? Date.now()).toLocaleString('zh-CN')}
                        </div>
                      </div>
                      <div className={styles.metricCard}>
                        <div className={styles.metricLabel}>当前状态</div>
                        <div className={styles.metricValue}>
                          {botBindState.status === 'bound'
                            ? '已绑定'
                            : botBindState.status === 'error'
                              ? '绑定异常'
                              : botBindState.status === 'unbound'
                                ? '已解绑'
                                : '等待扫码'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
            {settingsTab === 'tools' && (
              <div className={styles.modalSection}>
                <div className={styles.modalLabel}>工具权限</div>
                <div className={styles.policyGrid}>
                  {toolPolicies.map((policy) => (
                    <div key={policy.name} className={styles.policyCard}>
                      <div className={styles.policyHeader}>
                        <div>
                          <div className={styles.policyName}>{policy.name}</div>
                          <div className={styles.policyDesc}>{policy.description}</div>
                        </div>
                        <span className={`${styles.policyConfirm} ${policy.requiresConfirmation ? styles.policyConfirmOn : styles.policyConfirmOff}`}>
                          {policy.requiresConfirmation ? '需确认' : '自动执行'}
                        </span>
                      </div>
                      <div className={styles.policyRiskRow}>
                        {policy.risk.map((risk) => (
                          <span key={risk} className={styles.policyRisk}>{risk}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {toolPolicies.length === 0 && (
                    <div className={styles.emptyHint}>暂无工具策略数据。</div>
                  )}
                </div>
              </div>
            )}

            {settingsTab === 'diagnostics' && (
              <div className={styles.modalSection}>
                <div className={styles.modalLabel}>日志与诊断</div>
                <div className={styles.traceList}>
                  {traceSummaries.map((trace) => (
                    <div key={trace.traceId} className={styles.traceCard}>
                      <div className={styles.traceHeader}>
                        <code>{trace.traceId}</code>
                        <span>{trace.lastEventType}</span>
                      </div>
                      <div className={styles.traceMeta}>
                        <span>{trace.eventCount} 个事件</span>
                        <span>更新于 {new Date(trace.updatedAt).toLocaleString('zh-CN')}</span>
                      </div>
                    </div>
                  ))}
                  {traceSummaries.length === 0 && (
                    <div className={styles.emptyHint}>暂无 Trace。执行一次聊天、RAG 或任务后会出现在这里。</div>
                  )}
                </div>
              </div>
            )}
                </div>

                <div className={styles.modalActions}>
                  <button className={styles.secondaryBtn} onClick={() => void refreshModelConfig()}>
                    刷新配置
                  </button>
                  <button className={styles.secondaryBtn} onClick={() => setShowModelConfig(false)}>
                    取消
                  </button>
                  <button className={styles.primaryBtn} onClick={() => void handleSaveModelConfig()}>
                    保存设置
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
