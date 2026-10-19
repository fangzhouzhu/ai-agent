export type ModelProvider = 'ollama' | 'openai-compatible'
export type RouteModelConfig = { provider: ModelProvider; model: string }
export type OnlineProviderConfig = { name: string; provider: string; baseUrl: string; apiKey: string }
export type SavedOnlineProfile = OnlineProviderConfig & {
  id: string
  chatModel?: string
  agentModel?: string
  ragModel?: string
  models?: string[]
  createdAt: number
  updatedAt: number
}
export type ModelRouteConfig = {
  chat: RouteModelConfig
  agent: RouteModelConfig
  rag: RouteModelConfig
  online: OnlineProviderConfig
  onlineProfiles: SavedOnlineProfile[]
  activeOnlineProfileId: string | null
}

export function validateOnlineConnection(online: OnlineProviderConfig): string | null {
  try {
    const url = new URL(online.baseUrl.trim())
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return '请输入有效的 HTTP 或 HTTPS 接口地址，不要包含密钥、查询参数或片段。'
    }
  } catch {
    return '请填写完整的接口地址，例如 https://api.openai.com/v1。'
  }
  if (!online.apiKey.trim()) return '请填写 API Key。'
  return null
}

// Save the editor and its profile together so one click cannot leave a stale preset.
export function prepareModelSettings(config: ModelRouteConfig, newId: string, fetchedModels: string[]): ModelRouteConfig {
  const route = { ...config.chat, model: config.chat.model.trim() }
  if (!route.model) throw new Error('请选择或输入默认模型。')
  const next = { ...config, chat: route, agent: { ...route }, rag: { ...route } }
  if (route.provider === 'ollama') return next
  const error = validateOnlineConnection(config.online)
  if (error) throw new Error(error)
  const online = {
    ...config.online,
    name: config.online.name.trim() || config.online.provider,
    baseUrl: config.online.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.online.apiKey.trim(),
  }
  const existing = config.onlineProfiles.find((p) => p.id === config.activeOnlineProfileId)
  if (config.onlineProfiles.some((p) => p.id !== existing?.id && p.name.trim() === online.name)) {
    throw new Error('配置名称已存在，请换一个名称。')
  }
  const now = Date.now()
  const sameConnection = existing?.provider === online.provider
    && existing?.baseUrl.replace(/\/+$/, '') === online.baseUrl
    && existing?.apiKey === online.apiKey
  const profile: SavedOnlineProfile = {
    ...online,
    id: existing?.id ?? newId,
    chatModel: route.model,
    agentModel: route.model,
    ragModel: route.model,
    models: [...new Set([route.model, ...(fetchedModels.length ? fetchedModels : sameConnection ? existing?.models ?? [] : [])])],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  }
  return {
    ...next,
    online,
    activeOnlineProfileId: profile.id,
    onlineProfiles: existing
      ? config.onlineProfiles.map((p) => p.id === profile.id ? profile : p)
      : [profile, ...config.onlineProfiles],
  }
}
