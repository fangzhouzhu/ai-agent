import React, { useCallback, useEffect, useMemo, useState } from 'react'
import styles from './SkillsPanel.module.css'
import type { SkillAttachment, SkillConfig } from '../../../preload/index'
import { useAppDialog } from './AppDialogProvider'

type SkillDraft = {
  id?: string
  name: string
  description: string
  keywords: string[]
  systemPrompt: string
  attachments: SkillAttachment[]
  enabled: boolean
  priority: number
  createdAt?: number
}

function createDraft(skill?: SkillConfig): SkillDraft {
  return {
    id: skill?.id,
    name: skill?.name ?? '',
    description: skill?.description ?? '',
    keywords: skill?.keywords ?? [],
    systemPrompt: skill?.systemPrompt ?? '',
    attachments: skill?.attachments ?? [],
    enabled: skill?.enabled ?? true,
    priority: skill?.priority ?? 50,
    createdAt: skill?.createdAt,
  }
}

function normalizeSkill(draft: SkillDraft): SkillConfig {
  const now = Date.now()
  return {
    id: draft.id ?? crypto.randomUUID(),
    name: draft.name.trim(),
    description: draft.description.trim(),
    keywords: Array.from(new Set(draft.keywords.map((item) => item.trim()).filter(Boolean))),
    systemPrompt: draft.systemPrompt.trim(),
    attachments: Array.from(
      new Map(
        draft.attachments
          .filter((item) => item.path?.trim())
          .map((item) => [item.path, { ...item, name: item.name.trim() || item.path }]),
      ).values(),
    ),
    enabled: draft.enabled,
    preferredScene: 'auto',
    priority: Math.max(0, Math.min(100, Number(draft.priority) || 0)),
    createdAt: draft.createdAt ?? now,
    updatedAt: now,
  }
}

const SkillsPanel: React.FC = () => {
  const { confirm } = useAppDialog()
  const [skills, setSkills] = useState<SkillConfig[]>([])
  const [draft, setDraft] = useState<SkillDraft | null>(null)
  const [keywordInput, setKeywordInput] = useState('')
  const [showKeywordInput, setShowKeywordInput] = useState(false)
  const [editingKeywordIndex, setEditingKeywordIndex] = useState<number | null>(null)
  const [editingKeywordValue, setEditingKeywordValue] = useState('')
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)

  const sortedSkills = useMemo(
    () => [...skills].sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt),
    [skills],
  )

  const reload = useCallback(async () => {
    const saved = await window.electronAPI.listSkills()
    setSkills([...saved].sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt))
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!menuOpenId) return

    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element) || !target.closest('[data-skill-menu-root]')) {
        setMenuOpenId(null)
      }
    }

    document.addEventListener('mousedown', closeOnOutsideClick)
    return () => document.removeEventListener('mousedown', closeOnOutsideClick)
  }, [menuOpenId])

  const persist = useCallback(async (nextSkills: SkillConfig[]) => {
    const saved = await window.electronAPI.saveSkills(
      [...nextSkills].sort((a, b) => b.priority - a.priority || b.updatedAt - a.updatedAt),
    )
    setSkills(saved)
  }, [])

  const handleSaveDraft = useCallback(async () => {
    if (!draft) return
    const nextSkill = normalizeSkill(draft)

    if (!nextSkill.name) {
      window.alert('请填写技能名称')
      return
    }
    if (!nextSkill.systemPrompt) {
      window.alert('请填写自定义提示词')
      return
    }
    const duplicate = skills.find(
      (skill) => skill.id !== nextSkill.id && skill.name.trim() === nextSkill.name,
    )
    if (duplicate) {
      window.alert('技能名称不能重复')
      return
    }

    const nextSkills = skills.some((skill) => skill.id === nextSkill.id)
      ? skills.map((skill) => (skill.id === nextSkill.id ? nextSkill : skill))
      : [nextSkill, ...skills]
    await persist(nextSkills)
    setDraft(null)
  }, [draft, persist, skills])

  const handleDelete = useCallback(
    async (skillId: string) => {
      const target = skills.find((skill) => skill.id === skillId)
      if (!target) return
      if (!await confirm({ message: `确定删除技能“${target.name}”吗？`, tone: 'danger' })) return
      await persist(skills.filter((skill) => skill.id !== skillId))
      setMenuOpenId(null)
    },
    [confirm, persist, skills],
  )

  const handleToggle = useCallback(
    async (skillId: string, enabled: boolean) => {
      await persist(
        skills.map((skill) =>
          skill.id === skillId ? { ...skill, enabled, updatedAt: Date.now() } : skill,
        ),
      )
    },
    [persist, skills],
  )

  const handlePickAttachments = useCallback(async () => {
    const picked = await window.electronAPI.pickSkillFiles()
    if (picked.length === 0) return

    setDraft((prev) => {
      if (!prev) return prev
      const merged = new Map(prev.attachments.map((item) => [item.path, item]))
      picked.forEach((item) => merged.set(item.path, item))
      return { ...prev, attachments: [...merged.values()] }
    })
  }, [])

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    setDraft((prev) =>
      prev ? { ...prev, attachments: prev.attachments.filter((item) => item.id !== attachmentId) } : prev,
    )
  }, [])

  const formatFileSize = useCallback((size: number) => {
    if (!size || size <= 0) return '未知大小'
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }, [])

  const addKeyword = useCallback(() => {
    const value = keywordInput.trim()
    if (!value) return
    setDraft((prev) => {
      if (!prev || prev.keywords.includes(value)) return prev
      return { ...prev, keywords: [...prev.keywords, value] }
    })
    setKeywordInput('')
    setShowKeywordInput(false)
  }, [keywordInput])

  const removeKeyword = useCallback((index: number) => {
    setDraft((prev) =>
      prev ? { ...prev, keywords: prev.keywords.filter((_, itemIndex) => itemIndex !== index) } : prev,
    )
  }, [])

  const startEditKeyword = useCallback((index: number, value: string) => {
    setEditingKeywordIndex(index)
    setEditingKeywordValue(value)
  }, [])

  const commitKeywordEdit = useCallback(() => {
    if (editingKeywordIndex === null) return
    const value = editingKeywordValue.trim()
    setDraft((prev) => {
      if (!prev) return prev
      const next = prev.keywords.filter((_, index) => index !== editingKeywordIndex)
      if (value && !next.includes(value)) next.splice(editingKeywordIndex, 0, value)
      return { ...prev, keywords: next }
    })
    setEditingKeywordIndex(null)
    setEditingKeywordValue('')
  }, [editingKeywordIndex, editingKeywordValue])

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <h2>Skills</h2>
          <p>创建可复用的本地提示词技能，支持关键词或 #技能名 触发。</p>
        </div>
        <button
          className={styles.primaryBtn}
          onClick={() => {
            setDraft(createDraft())
            setKeywordInput('')
            setShowKeywordInput(false)
            setEditingKeywordIndex(null)
            setEditingKeywordValue('')
          }}
        >
          新增 Skill
        </button>
      </div>

      {sortedSkills.length === 0 ? (
        <div className={styles.emptyState}>
          <div className={styles.emptyTitle}>还没有 Skill</div>
          <div className={styles.emptyDesc}>新建一个技能后，它会以卡片形式显示在这里。</div>
        </div>
      ) : (
        <div className={styles.grid}>
          {sortedSkills.map((skill) => (
            <article key={skill.id} className={styles.card}>
              <div className={styles.cardTop}>
                <div className={styles.cardTitleGroup}>
                  <h3>{skill.name}</h3>
                  <span>优先级 {skill.priority}</span>
                </div>
                <div className={styles.cardActions}>
                  <label className={styles.switch} title={skill.enabled ? '已启用' : '已停用'}>
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      onChange={(e) => void handleToggle(skill.id, e.target.checked)}
                    />
                    <span />
                  </label>
                  <div className={styles.moreWrap} data-skill-menu-root>
                    <button
                      className={styles.moreBtn}
                      onClick={() => setMenuOpenId((current) => (current === skill.id ? null : skill.id))}
                      aria-label="更多操作"
                      title="更多"
                    >
                      <span className={styles.moreIcon} aria-hidden="true" />
                    </button>
                    {menuOpenId === skill.id && (
                      <div className={styles.menu}>
                        <button
                          onClick={() => {
                            setDraft(createDraft(skill))
                            setKeywordInput('')
                            setShowKeywordInput(false)
                            setEditingKeywordIndex(null)
                            setEditingKeywordValue('')
                            setMenuOpenId(null)
                          }}
                        >
                          编辑
                        </button>
                        <button className={styles.menuDanger} onClick={() => void handleDelete(skill.id)}>
                          删除
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <p className={styles.description}>{skill.description || '未填写技能说明'}</p>
              {skill.attachments && skill.attachments.length > 0 && (
                <div className={styles.assetMeta}>资料 {skill.attachments.length} 份</div>
              )}
              {skill.keywords.length > 0 && (
                <div className={styles.tags}>
                  {skill.keywords.slice(0, 6).map((keyword) => (
                    <span key={`${skill.id}-${keyword}`}>{keyword}</span>
                  ))}
                </div>
              )}
              <div className={styles.promptPreview}>{skill.systemPrompt}</div>
            </article>
          ))}
        </div>
      )}

      {draft && (
        <div className={styles.modalOverlay} onMouseDown={(e) => e.target === e.currentTarget && setDraft(null)}>
          <form
            className={styles.modal}
            onSubmit={(e) => {
              e.preventDefault()
              void handleSaveDraft()
            }}
          >
            <div className={styles.modalHeader}>
              <div className={styles.modalTitleBlock}>
                <div>
                  <h3>{draft.id ? '编辑 Skill' : '新增 Skill'}</h3>
                  <p>保存后会立即写入本地技能库。</p>
                </div>
                <label className={styles.enableSwitch}>
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft((prev) => (prev ? { ...prev, enabled: e.target.checked } : prev))}
                  />
                  <span className={styles.enableSwitchTrack} />
                  <span className={styles.enableSwitchText}>启用 Skill</span>
                </label>
              </div>
              <button type="button" className={styles.closeBtn} onClick={() => setDraft(null)}>
                ×
              </button>
            </div>

            <div className={styles.formStack}>
              <label className={styles.field}>
                <span>技能名称</span>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
                  placeholder="例如：前端代码审查"
                  autoFocus
                />
              </label>
              <label className={styles.field}>
                <span>优先级（0-100）</span>
                <small>多个 Skill 同时匹配时，优先级越高越先使用。</small>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={draft.priority}
                  onChange={(e) =>
                    setDraft((prev) => (prev ? { ...prev, priority: Number(e.target.value) || 0 } : prev))
                  }
                />
              </label>
            </div>

            <div className={styles.keywordSection}>
              <div className={styles.keywordHeader}>
                <div className={styles.keywordTitleGroup}>
                  <span>触发关键词</span>
                  <button
                    type="button"
                    className={styles.keywordAddBtn}
                    onClick={() => setShowKeywordInput((value) => !value)}
                    aria-label="添加关键词"
                    title="添加关键词"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className={styles.keywordEditor}>
                {showKeywordInput && (
                  <div className={styles.keywordInputRow}>
                    <input
                      value={keywordInput}
                      onChange={(e) => setKeywordInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addKeyword()
                        }
                        if (e.key === 'Escape') {
                          setShowKeywordInput(false)
                          setKeywordInput('')
                        }
                      }}
                      placeholder="输入关键词后按 Enter"
                      autoFocus
                    />
                    <button type="button" onClick={addKeyword}>
                      添加
                    </button>
                  </div>
                )}

                <div className={styles.keywordTags}>
                {draft.keywords.map((keyword, index) => (
                  <span key={`${keyword}-${index}`} className={styles.keywordTag}>
                    {editingKeywordIndex === index ? (
                      <input
                        value={editingKeywordValue}
                        onChange={(e) => setEditingKeywordValue(e.target.value)}
                        onBlur={commitKeywordEdit}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            commitKeywordEdit()
                          }
                          if (e.key === 'Escape') {
                            setEditingKeywordIndex(null)
                            setEditingKeywordValue('')
                          }
                        }}
                        autoFocus
                      />
                    ) : (
                      <button type="button" onClick={() => startEditKeyword(index, keyword)}>
                        {keyword}
                      </button>
                    )}
                    <button type="button" className={styles.keywordRemove} onClick={() => removeKeyword(index)}>
                      ×
                    </button>
                  </span>
                ))}
                  {draft.keywords.length === 0 && !showKeywordInput && (
                    <span className={styles.keywordEmpty}>还没有关键词，点击右上角 + 添加</span>
                  )}
                </div>
              </div>
            </div>

            <div className={styles.assetSection}>
              <div className={styles.assetHeader}>
                <div>
                  <span>上传资料</span>
                  <p>常见做法是给 Skill 绑定专属文档、模板或参考材料，命中后自动参与回答。</p>
                </div>
                <button type="button" className={styles.assetUploadBtn} onClick={() => void handlePickAttachments()}>
                  上传文件
                </button>
              </div>

              <div className={styles.assetList}>
                {draft.attachments.length === 0 ? (
                  <div className={styles.assetEmpty}>还没有绑定资料，支持 txt、md、pdf、docx、csv、json、ts、js</div>
                ) : (
                  draft.attachments.map((attachment) => (
                    <div key={attachment.id} className={styles.assetItem}>
                      <div className={styles.assetInfo}>
                        <strong>{attachment.name}</strong>
                        <span>{formatFileSize(attachment.size)}</span>
                        <span title={attachment.path}>{attachment.path}</span>
                      </div>
                      <button
                        type="button"
                        className={styles.assetRemoveBtn}
                        onClick={() => handleRemoveAttachment(attachment.id)}
                      >
                        移除
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <label className={styles.field}>
              <span>技能说明</span>
              <input
                value={draft.description}
                onChange={(e) => setDraft((prev) => (prev ? { ...prev, description: e.target.value } : prev))}
                placeholder="简要说明这个技能适合解决什么任务"
              />
            </label>

            <label className={styles.field}>
              <span>自定义提示词</span>
              <textarea
                value={draft.systemPrompt}
                onChange={(e) => setDraft((prev) => (prev ? { ...prev, systemPrompt: e.target.value } : prev))}
                placeholder="例如：你是一名资深前端架构师，回答时先给结论，再给可执行步骤与代码示例。"
              />
            </label>

            <div className={styles.modalActions}>
              <button type="button" className={styles.secondaryBtn} onClick={() => setDraft(null)}>
                取消
              </button>
              <button type="submit" className={styles.primaryBtn}>
                保存
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export default SkillsPanel
