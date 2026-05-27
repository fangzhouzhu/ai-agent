import React, { useState, useRef, useCallback } from 'react'
import styles from './InputBar.module.css'

interface RagFileMeta {
  id: string
  name: string
  path: string
  chunks: number
  uploadedAt: number
}

type ModelProvider = 'ollama' | 'openai-compatible'
type RouteKey = 'chat' | 'agent' | 'rag'

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
}

type ModelRouteConfig = {
  chat: RouteModelConfig
  agent: RouteModelConfig
  rag: RouteModelConfig
  onlineProfiles: SavedOnlineProfile[]
  activeOnlineProfileId: string | null
}

type ModelOptionKind = 'local-source' | 'local-model' | 'online-profile' | 'online-model'

type ModelOption = {
  value: string
  label: string
  kind: ModelOptionKind
  provider: ModelProvider
  model?: string
  profileId?: string
}

interface Props {
  onSend: (message: string) => void
  onAbort: () => void
  isLoading: boolean
  isRagProcessing: boolean
  ragStatusText: string
  ragFiles: RagFileMeta[]
  onPickFiles: () => void | Promise<void>
  onRemoveFile: (id: string) => void | Promise<void>
  modelConfig: ModelRouteConfig
  localModels: string[]
  onlineModelCandidates: string[]
  onUpdateRoute: (routeKey: RouteKey, patch: Partial<RouteModelConfig>) => void | Promise<void>
  onApplyOnlineProfile: (profileId: string) => void | Promise<void>
}

function encodeOption(option: Omit<ModelOption, 'value' | 'label'>): string {
  return JSON.stringify(option)
}

function uniqueModels(models: Array<string | undefined>): string[] {
  return Array.from(
    new Set(
      models
        .map((model) => model?.trim())
        .filter((model): model is string => Boolean(model))
    )
  )
}

const InputBar: React.FC<Props> = ({
  onSend,
  onAbort,
  isLoading,
  isRagProcessing,
  ragStatusText,
  ragFiles,
  onPickFiles,
  onRemoveFile,
  modelConfig,
  localModels,
  onlineModelCandidates,
  onUpdateRoute,
  onApplyOnlineProfile,
}) => {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isBusy = isLoading || isRagProcessing
  const unifiedRoute = modelConfig.chat
  const activeOnlineProfile =
    modelConfig.onlineProfiles.find((item) => item.id === modelConfig.activeOnlineProfileId) ?? null
  const fallbackLocalModel =
    localModels.includes(unifiedRoute.model) ? unifiedRoute.model : (localModels[0] ?? unifiedRoute.model)

  const modelOptions: ModelOption[] = [
    ...(localModels.length > 0 || unifiedRoute.provider === 'ollama'
      ? [
          {
            kind: 'local-source' as const,
            provider: 'ollama' as const,
            model: fallbackLocalModel,
            value: encodeOption({
              kind: 'local-source' as const,
              provider: 'ollama' as const,
              model: fallbackLocalModel,
            }),
            label: `本地 Ollama${fallbackLocalModel ? ` · ${fallbackLocalModel}` : ''}`,
          },
        ]
      : []),
    ...localModels.map((model) => {
      const option = { kind: 'local-model' as const, provider: 'ollama' as const, model }
      return {
        ...option,
        value: encodeOption(option),
        label: `本地模型 · ${model}`,
      }
    }),
    ...modelConfig.onlineProfiles.flatMap((profile) => {
      const profileModels = uniqueModels([
        profile.chatModel,
        profile.agentModel,
        profile.ragModel,
        ...(profile.models ?? []),
        ...(profile.id === modelConfig.activeOnlineProfileId ? onlineModelCandidates : []),
      ])
      const defaultModel = profileModels[0] ?? profile.chatModel ?? profile.agentModel ?? profile.ragModel
      const profileOption = defaultModel
        ? [
            {
              kind: 'online-profile' as const,
              provider: 'openai-compatible' as const,
              profileId: profile.id,
              model: defaultModel,
              value: encodeOption({
                kind: 'online-profile' as const,
                provider: 'openai-compatible' as const,
                profileId: profile.id,
                model: defaultModel,
              }),
              label: `在线预设 · ${profile.name || profile.provider}`,
            },
          ]
        : []

      return [
        ...profileOption,
        ...profileModels.map((model) => {
          const option = {
            kind: 'online-model' as const,
            provider: 'openai-compatible' as const,
            profileId: profile.id,
            model,
          }
          return {
            ...option,
            value: encodeOption(option),
            label: `${profile.name || profile.provider} · ${model}`,
          }
        }),
      ]
    }),
  ]

  const currentOptionBase =
    unifiedRoute.provider === 'ollama'
      ? { kind: 'local-model' as const, provider: 'ollama' as const, model: unifiedRoute.model }
      : {
          kind: 'online-model' as const,
          provider: 'openai-compatible' as const,
          profileId: activeOnlineProfile?.id,
          model: unifiedRoute.model,
        }
  const currentValue = encodeOption(currentOptionBase)
  const normalizedOptions = modelOptions.some((option) => option.value === currentValue)
    ? modelOptions
    : [
        {
          ...currentOptionBase,
          value: currentValue,
          label:
            unifiedRoute.provider === 'ollama'
              ? `本地 Ollama · ${unifiedRoute.model || '未选择模型'}`
              : `${activeOnlineProfile?.name || '在线预设'} · ${unifiedRoute.model || '未选择模型'}`,
        },
        ...modelOptions,
      ]

  const handleModelChange = async (value: string) => {
    const selected = JSON.parse(value) as {
      kind: ModelOptionKind
      provider: ModelProvider
      model?: string
      profileId?: string
    }

    if (selected.provider === 'openai-compatible' && selected.profileId) {
      await onApplyOnlineProfile(selected.profileId)
    }

    const nextModel =
      selected.model ||
      (selected.provider === 'ollama' ? (localModels[0] ?? unifiedRoute.model) : unifiedRoute.model)

    await onUpdateRoute('chat', {
      provider: selected.provider,
      model: nextModel,
    })
  }

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg || isBusy) return
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(msg)
  }, [input, isBusy, onSend])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }
  }

  const placeholder =
    isRagProcessing
      ? '文档正在分析中，请稍候，完成后即可提问...'
      : ragFiles.length > 0
        ? '基于已上传文档提问，例如：总结重点、提取结论、解释某一段...'
        : '输入消息...'

  return (
    <div className={styles.container}>
      <div className={styles.inner}>
        {(isRagProcessing || ragFiles.length > 0) && (
          <div className={styles.fileList}>
            {isRagProcessing && (
              <div className={styles.processingNotice}>
                <span className={styles.processingSpinner} />
                <span>{ragStatusText || '正在分析文档，请稍候...'}</span>
              </div>
            )}

            {ragFiles.map((file) => (
              <div key={file.id} className={styles.fileChip} title={`${file.name} · ${file.chunks} 个片段`}>
                <span className={styles.fileName}>{file.name}</span>
                <button
                  className={styles.fileRemove}
                  onClick={() => void onRemoveFile(file.id)}
                  title="移除该文档"
                  disabled={isRagProcessing}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.composer}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            spellCheck={false}
            rows={1}
          />

          <div className={styles.composerFooter}>
            <div className={styles.footerControls}>
              <button
                className={styles.uploadBtn}
                onClick={() => void onPickFiles()}
                disabled={isBusy}
                title="上传文档用于 RAG 分析"
              >
                上传文档
              </button>

              <select
                className={styles.modelSelect}
                value={currentValue}
                onChange={(e) => void handleModelChange(e.target.value)}
                disabled={normalizedOptions.length === 0}
                title="发送消息时所有场景统一生效"
              >
                {normalizedOptions.length === 0 ? (
                  <option value="">未检测到可用模型</option>
                ) : (
                  normalizedOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                )}
              </select>
            </div>

            <div className={styles.footerActions}>
              <span className={styles.hint}>Enter 发送，Shift+Enter 换行</span>
              {isLoading ? (
                <button className={styles.stopBtn} onClick={onAbort} title="停止生成">
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className={styles.sendBtn}
                  onClick={handleSend}
                  disabled={!input.trim() || isBusy}
                  title="发送消息"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export default InputBar
