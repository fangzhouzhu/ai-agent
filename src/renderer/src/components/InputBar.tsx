import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ImageAttachment } from '../../../preload'
import CustomSelect from './CustomSelect'
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

type SkillConfig = {
  id: string
  name: string
  description: string
  enabled: boolean
}

type AgentOption = {
  id: string
  name: string
}

type InputContextMenuState = {
  x: number
  y: number
  canCopy: boolean
  canCut: boolean
  canPaste: boolean
}

interface Props {
  onSend: (message: string, mode: 'chat' | 'task', attachments: ImageAttachment[]) => void
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
  skills: SkillConfig[]
  agents: AgentOption[]
  selectedAgentId: string
  canSelectAgent: boolean
  onSelectAgent: (agentId: string) => void | Promise<void>
  onUpdateRoute: (routeKey: RouteKey, patch: Partial<RouteModelConfig>) => void | Promise<void>
  onApplyOnlineProfile: (profileId: string) => void | Promise<void>
}

function encodeOption(option: Omit<ModelOption, 'value' | 'label'>): string {
  return JSON.stringify(option)
}

function uniqueModels(models: Array<string | undefined>): string[] {
  return Array.from(new Set(models.map((model) => model?.trim()).filter((model): model is string => Boolean(model))))
}

function normalizeSkillToken(value: string): string {
  return value.trim().toLowerCase()
}

function getSkillByExactName(token: string, skills: SkillConfig[], selectedIds: Set<string>) {
  const normalized = normalizeSkillToken(token)
  return (
    skills.find((skill) => skill.enabled && !selectedIds.has(skill.id) && normalizeSkillToken(skill.name) === normalized) ??
    null
  )
}

function getSkillQueryContext(input: string, caret: number) {
  const safeCaret = Math.max(0, Math.min(caret, input.length))
  const beforeCaret = input.slice(0, safeCaret)
  const hashIndex = beforeCaret.lastIndexOf('#')
  if (hashIndex < 0) return null

  const token = beforeCaret.slice(hashIndex + 1)
  if (/[\s，。,！!？?；;：:()[\]（）]/.test(token)) return null

  return {
    start: hashIndex,
    end: safeCaret,
    query: token.trim(),
  }
}

function filterSuggestedSkills(skills: SkillConfig[], query: string, selectedIds: Set<string>): SkillConfig[] {
  const normalizedQuery = normalizeSkillToken(query)
  return skills
    .filter((skill) => skill.enabled && !selectedIds.has(skill.id))
    .filter((skill) => {
      if (!normalizedQuery) return true
      return (
        normalizeSkillToken(skill.name).includes(normalizedQuery) ||
        normalizeSkillToken(skill.description).includes(normalizedQuery)
      )
    })
    .slice(0, 5)
}

function resizeTextarea(textarea: HTMLTextAreaElement | null) {
  if (!textarea) return
  textarea.style.height = 'auto'
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })
}

function getImageSize(dataUrl: string): Promise<{ width?: number; height?: number }> {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => resolve({})
    image.src = dataUrl
  })
}

async function createImageAttachment(file: File, source: ImageAttachment['source']): Promise<ImageAttachment> {
  const dataUrl = await readFileAsDataUrl(file)
  const size = await getImageSize(dataUrl)
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: file.name || `image-${Date.now()}.png`,
    mimeType: file.type || 'image/png',
    dataUrl,
    size: file.size,
    width: size.width,
    height: size.height,
    source,
  }
}

function getCaret(textarea: HTMLTextAreaElement | null, fallback: number) {
  return textarea?.selectionStart ?? fallback
}

function hasSelection(textarea: HTMLTextAreaElement) {
  return textarea.selectionStart !== textarea.selectionEnd
}

function insertSkillTag(input: string, start: number, end: number, skillName: string) {
  const prefix = input.slice(0, start)
  const suffix = input.slice(end)
  const compactPrefix = prefix.replace(/\s+$/, '')
  const nextPrefix = compactPrefix ? `${compactPrefix} ` : ''
  const nextSuffix = suffix.replace(/^\s+/, '')
  return `${nextPrefix}${nextSuffix}`
}

function extractSkillsFromInput(input: string, skills: SkillConfig[], selectedIds: Set<string>) {
  const regex = /#([^\s#，。,！!？?；;：:()[\]（）]+)/g
  const added: SkillConfig[] = []
  const parts: string[] = []
  let lastIndex = 0

  for (const match of input.matchAll(regex)) {
    const token = match[1] ?? ''
    const raw = match[0] ?? ''
    const index = match.index ?? 0
    const skill = getSkillByExactName(token, skills, new Set([...selectedIds, ...added.map((item) => item.id)]))

    parts.push(input.slice(lastIndex, index))
    if (skill) {
      added.push(skill)
    } else {
      parts.push(raw)
    }
    lastIndex = index + raw.length
  }

  parts.push(input.slice(lastIndex))
  const nextInput = parts.join('').replace(/\s{2,}/g, ' ').trimStart()

  return { nextInput, added }
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
  skills,
  agents,
  selectedAgentId,
  canSelectAgent,
  onSelectAgent,
  onUpdateRoute,
  onApplyOnlineProfile,
}) => {
  const [input, setInput] = useState('')
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [sendMode, setSendMode] = useState<'chat' | 'task'>('chat')
  const [selectedSkills, setSelectedSkills] = useState<SkillConfig[]>([])
  const [activeSuggestionIndex, setActiveSuggestionIndex] = useState(0)
  const [suggestionPlacement, setSuggestionPlacement] = useState<'below' | 'above'>('below')
  const [contextMenu, setContextMenu] = useState<InputContextMenuState | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const inputStageRef = useRef<HTMLDivElement>(null)
  const suggestionDropdownRef = useRef<HTMLDivElement>(null)
  const isBusy = isLoading || isRagProcessing
  const unifiedRoute = modelConfig.chat
  const activeOnlineProfile =
    modelConfig.onlineProfiles.find((item) => item.id === modelConfig.activeOnlineProfileId) ?? null
  const fallbackLocalModel =
    localModels.includes(unifiedRoute.model) ? unifiedRoute.model : (localModels[0] ?? unifiedRoute.model)

  const selectedSkillIds = useMemo(() => new Set(selectedSkills.map((skill) => skill.id)), [selectedSkills])
  const skillQueryContext = getSkillQueryContext(input, getCaret(textareaRef.current, input.length))
  const suggestedSkills = useMemo(
    () => filterSuggestedSkills(skills, skillQueryContext?.query ?? '', selectedSkillIds),
    [skills, skillQueryContext?.query, selectedSkillIds]
  )
  const contextMenuItems = useMemo(
    () => [
      { action: 'copy' as const, label: '复制', shortcut: 'Ctrl+C', disabled: !contextMenu?.canCopy },
      { action: 'paste' as const, label: '粘贴', shortcut: 'Ctrl+V', disabled: !contextMenu?.canPaste },
      { action: 'cut' as const, label: '剪切', shortcut: 'Ctrl+X', disabled: !contextMenu?.canCut },
    ],
    [contextMenu]
  )

  useEffect(() => {
    if (!contextMenu) return

    const closeMenu = () => setContextMenu(null)
    window.addEventListener('click', closeMenu)
    window.addEventListener('resize', closeMenu)
    window.addEventListener('scroll', closeMenu, true)

    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('resize', closeMenu)
      window.removeEventListener('scroll', closeMenu, true)
    }
  }, [contextMenu])

  useEffect(() => {
    if (!skillQueryContext || suggestedSkills.length === 0) return

    const updateSuggestionPlacement = () => {
      const root = inputStageRef.current
      const dropdown = suggestionDropdownRef.current
      if (!root || !dropdown) return

      const rootRect = root.getBoundingClientRect()
      const dropdownHeight = dropdown.offsetHeight
      const viewportHeight = window.innerHeight
      const spaceBelow = viewportHeight - rootRect.bottom
      const spaceAbove = rootRect.top

      if (spaceBelow < dropdownHeight + 8 && spaceAbove > spaceBelow) {
        setSuggestionPlacement('above')
        return
      }

      setSuggestionPlacement('below')
    }

    updateSuggestionPlacement()
    window.addEventListener('resize', updateSuggestionPlacement)
    window.addEventListener('scroll', updateSuggestionPlacement, true)

    return () => {
      window.removeEventListener('resize', updateSuggestionPlacement)
      window.removeEventListener('scroll', updateSuggestionPlacement, true)
    }
  }, [skillQueryContext, suggestedSkills.length, input, selectedSkills.length])

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

  const applySuggestion = (skill: SkillConfig) => {
    if (!skillQueryContext) return

    const nextInput = insertSkillTag(input, skillQueryContext.start, skillQueryContext.end, skill.name)
    setSelectedSkills((prev) => (prev.some((item) => item.id === skill.id) ? prev : [...prev, skill]))
    setInput(nextInput)
    setActiveSuggestionIndex(0)

    requestAnimationFrame(() => {
      resizeTextarea(textareaRef.current)
      textareaRef.current?.focus()
    })
  }

  const removeSelectedSkill = (skillId: string) => {
    setSelectedSkills((prev) => prev.filter((skill) => skill.id !== skillId))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handleSend = () => {
    const skillPrefix = selectedSkills.map((skill) => `#${skill.name}`).join(' ')
    const message = [skillPrefix, input.trim()].filter(Boolean).join(' ').trim()
    if ((!message && imageAttachments.length === 0) || isBusy) return

    setInput('')
    setImageAttachments([])
    setSelectedSkills([])
    setActiveSuggestionIndex(0)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(message, sendMode, imageAttachments)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (contextMenu && e.key === 'Escape') {
      e.preventDefault()
      setContextMenu(null)
      return
    }

    if (skillQueryContext && suggestedSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveSuggestionIndex((current) => (current >= suggestedSkills.length - 1 ? 0 : current + 1))
        return
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveSuggestionIndex((current) => (current <= 0 ? suggestedSkills.length - 1 : current - 1))
        return
      }

      if ((e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) && activeSuggestionIndex >= 0) {
        e.preventDefault()
        applySuggestion(suggestedSkills[activeSuggestionIndex])
        return
      }
    }

    if (e.key === 'Backspace' && !input && selectedSkills.length > 0) {
      e.preventDefault()
      setSelectedSkills((prev) => prev.slice(0, -1))
      return
    }

    if (e.key === 'Escape') {
      setActiveSuggestionIndex(0)
      return
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const rawValue = e.target.value
    const extracted = extractSkillsFromInput(rawValue, skills, selectedSkillIds)
    if (extracted.added.length > 0) {
      setSelectedSkills((prev) => [...prev, ...extracted.added])
    }
    setInput(extracted.nextInput)
    setActiveSuggestionIndex(0)
    requestAnimationFrame(() => resizeTextarea(textareaRef.current))
  }

  const appendImages = async (files: FileList | File[], source: ImageAttachment['source']) => {
    const imageFiles = Array.from(files).filter((file) => file.type.startsWith('image/'))
    if (imageFiles.length === 0) return

    const nextAttachments = await Promise.all(imageFiles.map((file) => createImageAttachment(file, source)))
    setImageAttachments((prev) => [...prev, ...nextAttachments].slice(0, 6))
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file))

    if (imageFiles.length === 0) return

    e.preventDefault()
    void appendImages(imageFiles, 'paste')
  }

  const removeImageAttachment = (attachmentId: string) => {
    setImageAttachments((prev) => prev.filter((item) => item.id !== attachmentId))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const handleTextareaContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault()

    const textarea = e.currentTarget
    textarea.focus()
    const stageRect = inputStageRef.current?.getBoundingClientRect()
    const canCopy = hasSelection(textarea)
    const canCut = hasSelection(textarea) && !textarea.readOnly && !textarea.disabled
    const canPaste = !textarea.readOnly && !textarea.disabled
    const estimatedMenuWidth = 136
    const estimatedMenuHeight = 86
    const fallbackX = 8
    const fallbackY = 8
    const rawX = stageRect ? e.clientX - stageRect.left : fallbackX
    const rawY = stageRect ? e.clientY - stageRect.top : fallbackY
    const viewportSpaceBelow = window.innerHeight - e.clientY
    const nextX = stageRect
      ? Math.min(Math.max(8, rawX), Math.max(8, stageRect.width - estimatedMenuWidth))
      : Math.max(8, rawX)
    const nextY =
      stageRect && viewportSpaceBelow < estimatedMenuHeight + 12
        ? Math.max(8, rawY - estimatedMenuHeight)
        : Math.max(8, rawY)

    setContextMenu({
      x: nextX,
      y: nextY,
      canCopy,
      canCut,
      canPaste,
    })
  }

  const handleContextMenuAction = (action: 'copy' | 'cut' | 'paste', disabled: boolean) => {
    if (disabled) return
    textareaRef.current?.focus()
    void window.electronAPI.performInputEditAction(action)
    setContextMenu(null)
  }

  const contextMenuStyle =
    contextMenu && inputStageRef.current
      ? {
          left: `${Math.min(contextMenu.x, Math.max(8, inputStageRef.current.clientWidth - 144))}px`,
          top: `${contextMenu.y}px`,
        }
      : undefined

  const placeholder =
    sendMode === 'task'
      ? '描述一个要在后台持续执行的任务，例如：整理竞品信息并生成 PDF 报告...'
      : isRagProcessing
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
          <div className={styles.inputStage} ref={inputStageRef}>
            <div className={styles.inputShell} onClick={() => textareaRef.current?.focus()}>
              <div className={styles.inputTopRow}>
                <div className={styles.modeSwitch}>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${sendMode === 'chat' ? styles.modeBtnActive : ''}`}
                    onClick={() => setSendMode('chat')}
                    disabled={isBusy}
                  >
                    对话
                  </button>
                  <button
                    type="button"
                    className={`${styles.modeBtn} ${sendMode === 'task' ? styles.modeBtnActive : ''}`}
                    onClick={() => setSendMode('task')}
                    disabled={isBusy}
                  >
                    任务
                  </button>
                </div>
              </div>

              {selectedSkills.length > 0 && (
                <div className={styles.selectedSkillRow}>
                  {selectedSkills.map((skill) => (
                    <div
                      key={skill.id}
                      className={styles.selectedSkillChip}
                      title={skill.description?.trim() || skill.name}
                    >
                      <span>#{skill.name}</span>
                      <button
                        type="button"
                        className={styles.selectedSkillClose}
                        onClick={() => removeSelectedSkill(skill.id)}
                        aria-label={`移除技能 ${skill.name}`}
                        title="移除技能"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {imageAttachments.length > 0 && (
                <div className={styles.imagePreviewRow}>
                  {imageAttachments.map((attachment) => (
                    <div key={attachment.id} className={styles.imagePreviewCard}>
                      <img
                        className={styles.imagePreview}
                        src={attachment.dataUrl}
                        alt={attachment.name}
                      />
                      <button
                        type="button"
                        className={styles.imagePreviewRemove}
                        onClick={() => removeImageAttachment(attachment.id)}
                        title="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <textarea
                ref={textareaRef}
                className={styles.textarea}
                value={input}
                onChange={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onClick={() => setActiveSuggestionIndex(0)}
                onContextMenu={handleTextareaContextMenu}
                placeholder={placeholder}
                spellCheck={false}
                rows={1}
              />
            </div>

            {contextMenu && (
              <div
                className={styles.contextMenu}
                style={contextMenuStyle}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                {contextMenuItems.map((item) => (
                  <button
                    key={item.action}
                    type="button"
                    className={styles.contextMenuItem}
                    disabled={item.disabled}
                    onClick={() => handleContextMenuAction(item.action, item.disabled)}
                  >
                    <span>{item.label}</span>
                    <span className={styles.contextMenuShortcut}>{item.shortcut}</span>
                  </button>
                ))}
              </div>
            )}

            {skillQueryContext && suggestedSkills.length > 0 && (
              <div
                ref={suggestionDropdownRef}
                className={`${styles.suggestionDropdown} ${
                  suggestionPlacement === 'above' ? styles.suggestionDropdownAbove : ''
                }`}
              >
                <div className={styles.suggestionList}>
                  {suggestedSkills.map((skill, index) => (
                    <button
                      key={`${skill.id}-${skill.name}`}
                      type="button"
                      className={`${styles.suggestionItem} ${index === activeSuggestionIndex ? styles.suggestionItemActive : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        applySuggestion(skill)
                      }}
                      aria-label={`插入技能 ${skill.name}`}
                      title={skill.description?.trim() || skill.name}
                    >
                      <strong>#{skill.name}</strong>
                      <span>{skill.description?.trim() || '显式命中该技能'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

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

              <CustomSelect
                rootClassName={styles.agentSelectWrap}
                triggerClassName={styles.agentSelect}
                menuClassName={styles.selectMenu}
                optionClassName={styles.selectOption}
                optionSelectedClassName={styles.selectOptionSelected}
                value={selectedAgentId}
                onChange={(value) => onSelectAgent(value)}
                disabled={!canSelectAgent}
                title={canSelectAgent ? '选择当前新对话使用的智能体' : '对话开始后不可再次切换智能体'}
                options={[
                  { value: '', label: '通用' },
                  ...agents.map((agent) => ({ value: agent.id, label: agent.name })),
                ]}
              />

              <CustomSelect
                rootClassName={styles.modelSelectWrap}
                triggerClassName={styles.modelSelect}
                menuClassName={styles.selectMenu}
                optionClassName={styles.selectOption}
                optionSelectedClassName={styles.selectOptionSelected}
                value={currentValue}
                onChange={handleModelChange}
                disabled={normalizedOptions.length === 0}
                title="发送消息时所有场景统一生效"
                options={
                  normalizedOptions.length === 0
                    ? [{ value: '', label: '未检测到可用模型' }]
                    : normalizedOptions.map((option) => ({ value: option.value, label: option.label }))
                }
              />
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
                  disabled={(!input.trim() && selectedSkills.length === 0 && imageAttachments.length === 0) || isBusy}
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
