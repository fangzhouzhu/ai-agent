import React, { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBar from './components/InputBar'
import KnowledgeBasePanel from './components/KnowledgeBase'
import TaskPanel from './components/TaskPanel'
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

type RagFileMeta = {
  id: string
  name: string
  path: string
  chunks: number
  uploadedAt: number
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
  enabled: boolean
  preferredScene: SkillPreferredScene
  priority: number
  createdAt: number
  updatedAt: number
}

type ApiTestState = {
  status: 'idle' | 'testing' | 'success' | 'error'
  message: string
  models: string[]
  latencyMs?: number
  balanceInfo?: string
  testedAt?: number
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

const App: React.FC = () => {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [useAgent, setUseAgent] = useState(true)
  const [ragFiles, setRagFiles] = useState<RagFileMeta[]>([])
  const [isRagProcessing, setIsRagProcessing] = useState(false)
  const [ragStatusText, setRagStatusText] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [modelConfig, setModelConfig] = useState<ModelRouteConfig>(defaultModelConfig)
  const [draftModelConfig, setDraftModelConfig] = useState<ModelRouteConfig>(defaultModelConfig)
  const [showModelConfig, setShowModelConfig] = useState(false)
  const [settingsTab, setSettingsTab] = useState<'models' | 'skills'>('models')
  const [draftSkills, setDraftSkills] = useState<SkillConfig[]>([])
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  const [apiTestState, setApiTestState] = useState<ApiTestState>({
    status: 'idle',
    message: '',
    models: [],
  })
  const [ragContextId, setRagContextId] = useState(() => uuidv4())
  const [currentView, setCurrentView] = useState<'chat' | 'kb' | 'task'>('chat')
  const [selectedKbIds, setSelectedKbIds] = useState<string[]>([])
  const [runningTaskCount, setRunningTaskCount] = useState(0)

  const ragFilesRef = useRef<RagFileMeta[]>([])
  const streamingMsgIdRef = useRef<string | null>(null)
  const tokenQueueRef = useRef('')
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const typingTargetRef = useRef<{ convId: string; msgId: string } | null>(null)

  const refreshModelConfig = useCallback(async () => {
    const [availableModels, savedConfig, savedSkills] = await Promise.all([
      window.electronAPI.listModels(),
      window.electronAPI.getModelConfig(),
      window.electronAPI.listSkills(),
    ])

    const nextConfig = normalizeModelConfig(savedConfig)
    const nextSkills = [...savedSkills].sort(
      (a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt
    )

    setModels(availableModels)
    setModelConfig(nextConfig)
    setDraftModelConfig(nextConfig)
    setDraftSkills(nextSkills)
    setActiveSkillId((current) =>
      nextSkills.some((skill) => skill.id === current) ? current : (nextSkills[0]?.id ?? null)
    )
    setApiTestState({ status: 'idle', message: '', models: [] })
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
      if (task.status === 'running') {
        setRunningTaskCount((n) => n)
      }
      // 重新计算运行中任务数
      window.electronAPI.task.list().then((list) => {
        setRunningTaskCount(list.filter((t) => t.status === 'running').length)
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

  // 保存单条对话到磁盘
  const persistConversation = useCallback((conv: Conversation) => {
    const meta: ConvMeta = {
      id: conv.id,
      title: conv.title,
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
    const conv = createConversation()
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    setRagContextId(uuidv4())
    window.electronAPI.storage.save(
      { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt },
      []
    )
  }, [])

  // 切换对话
  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
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

  const updateDraftRoute = useCallback(
    (key: 'chat' | 'agent' | 'rag', patch: Partial<RouteModelConfig>) => {
      setDraftModelConfig((prev) => ({
        ...prev,
        [key]: {
          ...prev[key],
          ...patch,
        },
      }))
    },
    []
  )

  const updateOnlineConfig = useCallback((patch: Partial<OnlineProviderConfig>) => {
    setDraftModelConfig((prev) => ({
      ...prev,
      online: {
        ...prev.online,
        ...patch,
      },
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
    setDraftSkills((prev) =>
      prev.map((skill) =>
        skill.id === skillId
          ? {
              ...skill,
              ...patch,
              updatedAt: Date.now(),
            }
          : skill
      )
    )
  }, [])

  const handleAddSkill = useCallback(() => {
    const nextSkill = createEmptySkill()
    setDraftSkills((prev) => [nextSkill, ...prev])
    setActiveSkillId(nextSkill.id)
  }, [])

  const handleDeleteSkill = useCallback((skillId: string) => {
    setDraftSkills((prev) => prev.filter((skill) => skill.id !== skillId))
    setActiveSkillId((current) => (current === skillId ? null : current))
  }, [])

  const handleOpenModelConfig = useCallback(async () => {
    await refreshModelConfig()
    setSettingsTab('models')
    setShowModelConfig(true)
  }, [refreshModelConfig])

  const handleSaveModelConfig = useCallback(async () => {
    const routes = [
      { key: '普通聊天', value: draftModelConfig.chat },
      { key: '复杂任务 / Agent', value: draftModelConfig.agent },
      { key: '文档问答 / RAG', value: draftModelConfig.rag },
    ]

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

    const invalidSkill = draftSkills.find((skill) => !skill.name.trim())
    if (invalidSkill) {
      setActiveSkillId(invalidSkill.id)
      window.alert('请先为每个技能填写名称')
      return
    }

    const normalizedSkills = draftSkills
      .map((skill) => ({
        ...skill,
        name: skill.name.trim(),
        description: skill.description.trim(),
        systemPrompt: skill.systemPrompt.trim(),
        keywords: Array.from(new Set(skill.keywords.map((item) => item.trim()).filter(Boolean))),
        priority: Math.max(0, Math.min(100, Number(skill.priority) || 0)),
        updatedAt: Date.now(),
      }))
      .sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt)

    const [savedConfig, savedSkills] = await Promise.all([
      window.electronAPI.saveModelConfig(toSettingsPayload(draftModelConfig)),
      window.electronAPI.saveSkills(normalizedSkills),
    ])

    const nextConfig = normalizeModelConfig(savedConfig)
    setModelConfig(nextConfig)
    setDraftModelConfig(nextConfig)
    setDraftSkills(savedSkills)
    setActiveSkillId((current) =>
      savedSkills.some((skill) => skill.id === current) ? current : (savedSkills[0]?.id ?? null)
    )
    setShowModelConfig(false)
  }, [draftModelConfig, draftSkills])

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
  const activeSkillDraft = draftSkills.find((skill) => skill.id === activeSkillId) ?? null

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
      const pending = tokenQueueRef.current
      if (!pending) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current)
          typingTimerRef.current = null
        }
        return
      }

      // 队列积压时自动提速，避免看起来“卡在后面慢慢打”。
      const charsPerStep =
        pending.length > 240 ? 48 : pending.length > 120 ? 24 : pending.length > 60 ? 12 : 4
      const chunk = pending.slice(0, charsPerStep)
      tokenQueueRef.current = pending.slice(charsPerStep)
      appendToStreamingMessage(convId, msgId, chunk)
    },
    [appendToStreamingMessage]
  )

  const ensureTypingLoop = useCallback(
    (convId: string, msgId: string) => {
      typingTargetRef.current = { convId, msgId }
      if (typingTimerRef.current) return

      typingTimerRef.current = setInterval(() => {
        const target = typingTargetRef.current
        if (!target) return
        flushTypingStep(target.convId, target.msgId)
      }, 12)
    },
    [flushTypingStep]
  )

  const enqueueToken = useCallback(
    (convId: string, msgId: string, token: string) => {
      if (!token) return
      tokenQueueRef.current += token
      ensureTypingLoop(convId, msgId)
    },
    [ensureTypingLoop]
  )

  const flushAllQueuedTokens = useCallback((convId: string, msgId: string) => {
    if (!tokenQueueRef.current) return
    const rest = tokenQueueRef.current
    tokenQueueRef.current = ''
    appendToStreamingMessage(convId, msgId, rest)
  }, [appendToStreamingMessage])

  const resetTokenBuffer = useCallback(() => {
    tokenQueueRef.current = ''
    typingTargetRef.current = null
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current)
      typingTimerRef.current = null
    }
  }, [])

  // 中断请求
  const handleAbort = useCallback(() => {
    window.electronAPI.abortChat()
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
      if (isLoading || isRagProcessing || !activeId) return

      const targetConv = conversations.find((c) => c.id === activeId)
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
      const nextAiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
        ragContextId: targetRagContextId,
      }

      resetTokenBuffer()
      streamingMsgIdRef.current = aiMsgId
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: [...baseMessages, nextAiMsg],
                updatedAt: Date.now(),
              }
            : c
        )
      )

      setIsLoading(true)

      const removeToken = window.electronAPI.onToken((token) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        enqueueToken(activeId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ toolName, input }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
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

      const removeToolResult = window.electronAPI.onToolResult(({ toolName, result }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
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

      const removeModelInfo = window.electronAPI.onModelInfo((modelInfo) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
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

      const finalize = (errorUpdate?: Partial<Message>) => {
        flushAllQueuedTokens(activeId, aiMsgId)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === activeId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        setIsLoading(false)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(() => finalize())
      const removeError = window.electronAPI.onError((err) =>
        finalize({ content: `错误：${err}`, isError: true })
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeModelInfo()
        removeDone()
        removeError()
        resetTokenBuffer()
        streamingMsgIdRef.current = null
      }

      await window.electronAPI.sendMessage(
        history,
        userMsg.content,
        useAgent,
        ragFilesRef.current.map((file) => file.id),
        selectedKbIds
      )
    },
    [isLoading, isRagProcessing, activeId, conversations, persistConversation, useAgent, ragFiles, selectedKbIds, enqueueToken, flushAllQueuedTokens, resetTokenBuffer]
  )

  // 发送消息
  const handleSend = useCallback(
    async (text: string, agentMode: boolean) => {
      if (isLoading || isRagProcessing) return

      let convId = activeId
      if (!convId) {
        const conv = createConversation()
        setConversations((prev) => [conv, ...prev])
        setActiveId(conv.id)
        convId = conv.id
        window.electronAPI.storage.save(
          { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt },
          []
        )
      }

      const currentRagFiles = ragFilesRef.current
      const activeRagContextId = currentRagFiles.length > 0 ? ragContextId : undefined
      const userMsg: Message = {
        ...createMessage('user', text),
        ragContextId: activeRagContextId,
      }
      const aiMsgId = uuidv4()
      const aiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
        ragContextId: activeRagContextId,
      }

      resetTokenBuffer()
      streamingMsgIdRef.current = aiMsgId

      const targetConv = conversations.find((c) => c.id === convId)
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

      setIsLoading(true)

      const history = (targetConv?.messages ?? [])
        .filter((m) => (!activeRagContextId ? true : m.ragContextId === activeRagContextId))
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }))

      const removeToken = window.electronAPI.onToken((token) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        enqueueToken(convId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ toolName, input }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
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

      const removeToolResult = window.electronAPI.onToolResult(({ toolName, result }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
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

      const removeModelInfo = window.electronAPI.onModelInfo((modelInfo) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
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

      const finalize = (errorUpdate?: Partial<Message>) => {
        flushAllQueuedTokens(convId, aiMsgId)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === convId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        setIsLoading(false)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(() => finalize())

      const removeError = window.electronAPI.onError((err) =>
        finalize({ content: `错误：${err}`, isError: true })
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeModelInfo()
        removeDone()
        removeError()
        resetTokenBuffer()
        streamingMsgIdRef.current = null
      }

      await window.electronAPI.sendMessage(
        history,
        text,
        agentMode,
        currentRagFiles.map((file) => file.id),
        selectedKbIds
      )
    },
    [isLoading, isRagProcessing, activeId, conversations, ragFiles, ragContextId, selectedKbIds, persistConversation, enqueueToken, flushAllQueuedTokens, resetTokenBuffer]
  )

  return (
    <div className={styles.app}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        onOpenSettings={() => void handleOpenModelConfig()}
        currentView={currentView}
        onViewChange={setCurrentView}
        selectedKbCount={selectedKbIds.length}
        runningTaskCount={runningTaskCount}
      />
      <div className={styles.main}>
        {currentView === 'kb' ? (
          <KnowledgeBasePanel
            selectedKbIds={selectedKbIds}
            onSelectionChange={setSelectedKbIds}
          />
        ) : currentView === 'task' ? (
          <TaskPanel />
        ) : (
          <>
            <div className={styles.topbar}>
              <span className={styles.convTitle}>
                {activeConversation?.title ?? '新对话'}
              </span>
              <span className={styles.modelBadge}>
                自动模型路由 · {[
                  modelConfig.chat,
                  modelConfig.agent,
                  modelConfig.rag,
                ].some((route) => route.provider === 'openai-compatible')
                  ? '本地 / 在线'
                  : '本地 Ollama'}
                {selectedKbIds.length > 0 && ` · 知识库 ×${selectedKbIds.length}`}
              </span>
            </div>

            <ChatArea
              messages={activeConversation?.messages ?? []}
              isLoading={isLoading || (activeConversation !== null && !activeConversation.loaded)}
              onCopyMessage={handleCopyMessage}
              onEditUserMessage={handleEditUserMessage}
              onDeleteMessage={handleDeleteMessage}
              onRegenerateMessage={handleRegenerateMessage}
            />

            <InputBar
              onSend={handleSend}
              onAbort={handleAbort}
              isLoading={isLoading}
              isRagProcessing={isRagProcessing}
              ragStatusText={ragStatusText}
              useAgent={useAgent}
              onToggleAgent={() => setUseAgent((v) => !v)}
              ragFiles={ragFiles}
              onPickFiles={handlePickRagFiles}
              onRemoveFile={handleRemoveRagFile}
            />
          </>
        )}
      </div>

      {showModelConfig && (
        <div className={styles.modalOverlay} onClick={() => setShowModelConfig(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <div>
                <h3 className={styles.modalTitle}>设置</h3>
              </div>
              <button className={styles.modalClose} onClick={() => setShowModelConfig(false)}>
                ×
              </button>
            </div>

            <div className={styles.modalTabs}>
              <button
                className={`${styles.modalTab} ${settingsTab === 'models' ? styles.modalTabActive : ''}`}
                onClick={() => setSettingsTab('models')}
              >
                模型配置
              </button>
              <button
                className={`${styles.modalTab} ${settingsTab === 'skills' ? styles.modalTabActive : ''}`}
                onClick={() => setSettingsTab('skills')}
              >
                Skills 配置
              </button>
            </div>

            <div className={styles.modalBody}>
            {settingsTab === 'models' && (
              <>
            <div className={styles.modalSection}>
              <div className={styles.modalLabel}>场景路由</div>
              <div className={styles.routeGrid}>
                {([
                  { key: 'chat', label: '普通聊天', hint: '适合日常问答、轻量交流', placeholder: 'gpt-4o-mini / deepseek-chat / glm-4-flash' },
                  { key: 'agent', label: '复杂任务 / Agent', hint: '适合代码、分析、工具调用', placeholder: 'gpt-4.1 / deepseek-chat / glm-4-plus' },
                  { key: 'rag', label: '文档问答 / RAG', hint: '适合上传文件后的检索问答', placeholder: 'gpt-4o-mini / deepseek-chat / glm-4-flash' },
                ] as const).map((item) => {
                  const route = draftModelConfig[item.key]
                  const isOnline = route.provider === 'openai-compatible'

                  return (
                    <div key={item.key} className={styles.routeCard}>
                      <div className={styles.routeTitle}>{item.label}</div>
                      <div className={styles.routeHint}>{item.hint}</div>

                      <label className={styles.fieldItem}>
                        <span>运行来源</span>
                        <select
                          className={styles.fieldSelect}
                          value={route.provider}
                          onChange={(e) => {
                            const provider = e.target.value as ModelProvider

                            if (provider === 'ollama') {
                              updateDraftRoute(item.key, {
                                provider,
                                model:
                                  selectableModels.includes(route.model)
                                    ? route.model
                                    : (selectableModels[0] ?? ''),
                              })
                              return
                            }

                            const fallbackProfileId =
                              draftModelConfig.activeOnlineProfileId ??
                              draftModelConfig.onlineProfiles[0]?.id ??
                              null
                            const fallbackProfile = draftModelConfig.onlineProfiles.find(
                              (profile) => profile.id === fallbackProfileId
                            )

                            if (fallbackProfileId) {
                              applyOnlineProfile(fallbackProfileId)
                            }

                            const suggestedModels = Array.from(
                              new Set(
                                [
                                  ...(providerModelPresets[
                                    fallbackProfile?.provider ?? draftModelConfig.online.provider
                                  ] ?? []),
                                  ...apiTestState.models,
                                  fallbackProfile?.chatModel,
                                  fallbackProfile?.agentModel,
                                  fallbackProfile?.ragModel,
                                ].filter((model): model is string => Boolean(model))
                              )
                            )

                            const preferredModel =
                              item.key === 'chat'
                                ? fallbackProfile?.chatModel
                                : item.key === 'agent'
                                  ? fallbackProfile?.agentModel
                                  : fallbackProfile?.ragModel

                            updateDraftRoute(item.key, {
                              provider,
                              model: preferredModel || route.model || suggestedModels[0] || '',
                            })
                          }}
                        >
                          <option value="ollama">本地 Ollama</option>
                          <option value="openai-compatible">在线预设</option>
                        </select>
                      </label>

                      {isOnline ? (
                        <>
                          <label className={styles.fieldItem}>
                            <span>在线预设</span>
                            <select
                              className={styles.fieldSelect}
                              value={draftModelConfig.activeOnlineProfileId ?? ''}
                              onChange={(e) => {
                                const profileId = e.target.value
                                if (!profileId) return

                                const profile = draftModelConfig.onlineProfiles.find(
                                  (item) => item.id === profileId
                                )
                                applyOnlineProfile(profileId)

                                const suggestedModels = Array.from(
                                  new Set(
                                    [
                                      ...(providerModelPresets[
                                        profile?.provider ?? draftModelConfig.online.provider
                                      ] ?? []),
                                      ...apiTestState.models,
                                      profile?.chatModel,
                                      profile?.agentModel,
                                      profile?.ragModel,
                                    ].filter((model): model is string => Boolean(model))
                                  )
                                )

                                const preferredModel =
                                  item.key === 'chat'
                                    ? profile?.chatModel
                                    : item.key === 'agent'
                                      ? profile?.agentModel
                                      : profile?.ragModel

                                updateDraftRoute(item.key, {
                                  provider: 'openai-compatible',
                                  model: preferredModel || suggestedModels[0] || route.model,
                                })
                              }}
                              disabled={draftModelConfig.onlineProfiles.length === 0}
                            >
                              {draftModelConfig.onlineProfiles.length === 0 ? (
                                <option value="">请先创建在线预设</option>
                              ) : (
                                draftModelConfig.onlineProfiles.map((profile) => (
                                  <option key={`profile-${profile.id}`} value={profile.id}>
                                    {profile.name} · {profile.provider}
                                  </option>
                                ))
                              )}
                            </select>
                          </label>

                          <label className={styles.fieldItem}>
                            <span>可用模型</span>
                            <select
                              className={styles.fieldSelect}
                              value={route.model}
                              onChange={(e) => updateDraftRoute(item.key, { model: e.target.value })}
                              disabled={onlineModelCandidates.length === 0}
                            >
                              {Array.from(new Set([...onlineModelCandidates, route.model].filter(Boolean))).length === 0 ? (
                                <option value="">先选择预设或执行 API Test</option>
                              ) : (
                                Array.from(new Set([...onlineModelCandidates, route.model].filter(Boolean))).map((model) => (
                                  <option key={`${item.key}-online-${model}`} value={model}>
                                    {model}
                                  </option>
                                ))
                              )}
                            </select>
                            <span className={styles.fieldHint}>
                              从当前预设和可用模型列表中直接选择，无需手动输入。
                            </span>
                          </label>
                        </>
                      ) : (
                        <label className={styles.fieldItem}>
                          <span>本地模型</span>
                          <>
                            <select
                              className={styles.fieldSelect}
                              value={route.model}
                              onChange={(e) => updateDraftRoute(item.key, { model: e.target.value })}
                              disabled={selectableModels.length === 0}
                            >
                              {selectableModels.length === 0 ? (
                                <option value="">未检测到本地模型</option>
                              ) : (
                                selectableModels.map((model) => (
                                  <option key={`${item.key}-${model}`} value={model}>
                                    {model}
                                  </option>
                                ))
                              )}
                            </select>
                            <span className={styles.fieldHint}>
                              从已安装的 Ollama 模型中选择默认值。
                            </span>
                          </>
                        </label>
                      )}
                    </div>
                  )
                })}
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
                支持 OpenAI、DeepSeek、Moonshot、SiliconFlow、智谱 AI、OpenRouter 等兼容 OpenAI Chat Completions 的服务；创建并保存预设后，上方场景路由可直接选择该预设并从模型列表中切换，无需手动输入。密钥仅保存在本机。
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
                            onClick={() => {
                              if (window.confirm(`确定删除预设“${profile.name}”吗？`)) {
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
                        onClick={() => setActiveSkillId(skill.id)}
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
                          <span>
                            {skill.preferredScene === 'auto'
                              ? '自动路由'
                              : skill.preferredScene === 'chat'
                                ? '普通聊天'
                                : skill.preferredScene === 'agent'
                                  ? 'Agent / 工具'
                                  : 'RAG 优先'}
                          </span>
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
                    <>
                      <div className={styles.skillEditorHeader}>
                        <div>
                          <div className={styles.routeTitle}>{activeSkillDraft.name || '未命名技能'}</div>
                          <div className={styles.routeHint}>
                            技能只保存在当前设备本地，可影响提示词和自动路由策略。
                          </div>
                        </div>
                        <div className={styles.profileActions}>
                          <button
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
                            className={`${styles.miniBtn} ${styles.dangerBtn}`}
                            onClick={() => {
                              if (window.confirm(`确定删除技能“${activeSkillDraft.name || '未命名技能'}”吗？`)) {
                                handleDeleteSkill(activeSkillDraft.id)
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
                            value={activeSkillDraft.name}
                            onChange={(e) =>
                              updateDraftSkill(activeSkillDraft.id, { name: e.target.value })
                            }
                            placeholder="例如：写作助手 / 前端代码审查"
                          />
                        </label>

                        <label className={styles.fieldItem}>
                          <span>优先路由</span>
                          <select
                            className={styles.fieldSelect}
                            value={activeSkillDraft.preferredScene}
                            onChange={(e) =>
                              updateDraftSkill(activeSkillDraft.id, {
                                preferredScene: e.target.value as SkillPreferredScene,
                              })
                            }
                          >
                            <option value="auto">自动判断</option>
                            <option value="chat">普通聊天</option>
                            <option value="agent">Agent / 工具</option>
                            <option value="rag">RAG 优先</option>
                          </select>
                        </label>

                        <label className={styles.fieldItem}>
                          <span>优先级（0-100）</span>
                          <input
                            className={styles.fieldInput}
                            type="number"
                            min={0}
                            max={100}
                            value={activeSkillDraft.priority}
                            onChange={(e) =>
                              updateDraftSkill(activeSkillDraft.id, {
                                priority: Number(e.target.value) || 0,
                              })
                            }
                          />
                        </label>

                        <label className={styles.fieldItem}>
                          <span>触发关键词</span>
                          <input
                            className={styles.fieldInput}
                            value={formatSkillKeywords(activeSkillDraft.keywords)}
                            onChange={(e) =>
                              updateDraftSkill(activeSkillDraft.id, {
                                keywords: parseSkillKeywords(e.target.value),
                              })
                            }
                            placeholder="例如：润色, 摘要, 邮件"
                          />
                        </label>
                      </div>

                      <label className={styles.fieldItem}>
                        <span>技能说明</span>
                        <input
                          className={styles.fieldInput}
                          value={activeSkillDraft.description}
                          onChange={(e) =>
                            updateDraftSkill(activeSkillDraft.id, {
                              description: e.target.value,
                            })
                          }
                          placeholder="简要说明这个技能适合解决什么任务"
                        />
                      </label>

                      <label className={styles.fieldItem}>
                        <span>自定义提示词</span>
                        <textarea
                          className={styles.fieldTextarea}
                          value={activeSkillDraft.systemPrompt}
                          onChange={(e) =>
                            updateDraftSkill(activeSkillDraft.id, {
                              systemPrompt: e.target.value,
                            })
                          }
                          placeholder="例如：你是一名资深前端架构师，回答时先给结论，再给可执行步骤与代码示例。"
                        />
                      </label>
                    </>
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
            </div>

            <div className={styles.modalActions}>
              <button className={styles.secondaryBtn} onClick={() => void refreshModelConfig()}>
                刷新配置
              </button>
              <button className={styles.secondaryBtn} onClick={() => setShowModelConfig(false)}>
                取消
              </button>
              <button className={styles.primaryBtn} onClick={() => void handleSaveModelConfig()}>
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
