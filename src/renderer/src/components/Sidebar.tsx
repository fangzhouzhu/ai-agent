import React from 'react'
import type { Conversation } from '../types/conversation'
import styles from './Sidebar.module.css'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  models: string[]
  currentModel: string
  onModelChange: (model: string) => void
}

const Sidebar: React.FC<Props> = ({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  models,
  currentModel,
  onModelChange
}) => {
  return (
    <div className={styles.sidebar}>
      {/* 新建对话按钮 */}
      <div className={styles.header}>
        <span className={styles.logo}>🤖 AI Agent</span>
        <button className={styles.newBtn} onClick={onNew} title="新建对话">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* 模型选择 */}
      <div className={styles.modelSection}>
        <label className={styles.modelLabel}>模型</label>
        <select
          className={styles.modelSelect}
          value={currentModel}
          onChange={(e) => onModelChange(e.target.value)}
        >
          {models.length === 0 ? (
            <option value={currentModel}>{currentModel}</option>
          ) : (
            models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))
          )}
        </select>
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

      {/* 底部信息 */}
      <div className={styles.footer}>
        <div className={styles.footerInfo}>
          <span>🟢 Ollama 本地运行</span>
        </div>
      </div>
    </div>
  )
}

export default Sidebar
