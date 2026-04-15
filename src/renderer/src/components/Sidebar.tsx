import React, { useState, useCallback } from 'react'
import type { Conversation } from '../types/conversation'
import styles from './Sidebar.module.css'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  currentView: 'chat' | 'kb' | 'task'
  onViewChange: (view: 'chat' | 'kb' | 'task') => void
  selectedKbCount: number
  runningTaskCount: number
  ragOnly: boolean
  onRagOnlyChange: (v: boolean) => void
  minScore: number
  onMinScoreChange: (v: number) => void
}

const Sidebar: React.FC<Props> = ({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onOpenSettings,
  currentView,
  onViewChange,
  selectedKbCount,
  runningTaskCount,
  ragOnly,
  onRagOnlyChange,
  minScore,
  onMinScoreChange,
}) => {
  return (
    <div className={styles.sidebar}>
      {/* 新建对话按钮 */}
      <div className={styles.header}>
        <span className={styles.logo}>Centibot</span>
        <button className={styles.newBtn} onClick={onNew} title="新建对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* View switcher */}
      <div className={styles.viewTabs}>
        <button
          className={`${styles.viewTab} ${currentView === 'chat' ? styles.viewTabActive : ''}`}
          onClick={() => onViewChange('chat')}
        >
          对话
        </button>
        <button
          className={`${styles.viewTab} ${currentView === 'kb' ? styles.viewTabActive : ''}`}
          onClick={() => onViewChange('kb')}
        >
          知识库
          {selectedKbCount > 0 && (
            <span className={styles.kbBadge}>{selectedKbCount}</span>
          )}
        </button>
        <button
          className={`${styles.viewTab} ${currentView === 'task' ? styles.viewTabActive : ''}`}
          onClick={() => onViewChange('task')}
        >
          任务
          {runningTaskCount > 0 && (
            <span className={styles.taskBadge}>{runningTaskCount}</span>
          )}
        </button>
      </div>

      {currentView === 'chat' && (
        <>
          <div className={styles.modelSection}>
            <div className={styles.routingNote}>
              已开启智能模型路由：普通聊天、复杂任务、文档问答会自动匹配更合适的本地或在线模型，可在左下角设置中调整。
            </div>
          </div>

          {/* 会话列表 */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>历史对话</div>
            <div className={styles.list}>
              {conversations.length === 0 && (
                <div className={styles.empty}>暂无对话记录</div>
              )}
              {[...conversations]
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .map((conv) => (
                  <div
                    key={conv.id}
                    className={`${styles.item} ${conv.id === activeId ? styles.active : ''}`}
                    onClick={() => onSelect(conv.id)}
                  >
                    <span className={styles.itemIcon}>💬</span>
                    <span className={styles.itemTitle}>{conv.title}</span>
                    <button
                      className={styles.deleteBtn}
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(conv.id)
                      }}
                      title="删除"
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          </div>
        </>
      )}

      {currentView === 'kb' && (
        <div className={styles.kbViewArea}>
          <div className={styles.kbViewHint}>
            在右侧管理知识库，点击 ○ 选用后可在对话中使用
          </div>

          {/* RAG mode toggle */}
          <div className={styles.ragModeRow}>
            <div className={styles.ragModeInfo}>
              <span className={styles.ragModeLabel}>
                {ragOnly ? '仅限知识库' : '知识库优先'}
              </span>
              <span className={styles.ragModeDesc}>
                {ragOnly
                  ? '选中知识库后，仅根据知识库内容回答'
                  : '知识库无结果时自动用模型回答'}
              </span>
            </div>
            <button
              className={`${styles.toggleTrack} ${ragOnly ? styles.toggleOn : ''}`}
              onClick={() => onRagOnlyChange(!ragOnly)}
              title={ragOnly ? '开启：仅通过知识库回答' : '关闭：知识库优先，找不到再用模型'}
            >
              <span className={styles.toggleThumb} />
            </button>
          </div>

          {/* Relevance score threshold */}
          <div className={styles.scoreRow}>
            <div className={styles.scoreHeader}>
              <span className={styles.scoreLabel}>相关度阈值</span>
              <span className={styles.scoreValue}>{minScore.toFixed(2)}</span>
            </div>
            <input
              type="range"
              className={styles.scoreSlider}
              min={0.1}
              max={0.9}
              step={0.05}
              value={minScore}
              onChange={(e) => onMinScoreChange(parseFloat(e.target.value))}
              title="越高精准度越高，越低覆盖越广"
            />
            <span className={styles.scoreHint}>越高越精准 · 越低覆盖越广</span>
          </div>
        </div>
      )}

      {currentView === 'task' && (
        <div className={styles.kbViewArea}>
          <TaskCreateForm onViewChange={onViewChange} />
        </div>
      )}

      {/* 底部信息 */}
      <div className={styles.footer}>
        <div className={styles.footerInfo}>
          <span>🟢 本地 / 在线模型</span>
        </div>
        <button
          className={styles.settingsBtn}
          onClick={onOpenSettings}
          title="模型配置"
        >
          ⚙
        </button>
      </div>
    </div>
  )
}

const TaskCreateForm: React.FC<{ onViewChange: (view: 'chat' | 'kb' | 'task') => void }> = ({ onViewChange }) => {
  const [prompt, setPrompt] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  const handleCreate = useCallback(async () => {
    const text = prompt.trim()
    if (!text || isCreating) return
    setIsCreating(true)
    try {
      await window.electronAPI.task.create(text)
      setPrompt('')
      onViewChange('task')
    } finally {
      setIsCreating(false)
    }
  }, [prompt, isCreating, onViewChange])

  return (
    <div className={styles.taskCreateArea}>
      <span className={styles.taskCreateLabel}>✦ 新建任务</span>
      <textarea
        className={styles.taskPromptInput}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void handleCreate()
          }
        }}
        placeholder={'描述要完成的任务...\nCtrl+Enter 快速创建'}
        rows={4}
      />
      <button
        className={styles.taskCreateBtn}
        onClick={() => void handleCreate()}
        disabled={!prompt.trim() || isCreating}
      >
        {isCreating ? '创建中...' : '▶ 创建任务'}
      </button>
    </div>
  )
}

export default Sidebar
