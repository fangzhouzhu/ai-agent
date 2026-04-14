import React from 'react'
import type { Conversation } from '../types/conversation'
import styles from './Sidebar.module.css'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  currentView: 'chat' | 'kb'
  onViewChange: (view: 'chat' | 'kb') => void
  selectedKbCount: number
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
}) => {
  return (
    <div className={styles.sidebar}>
      {/* 新建对话按钮 */}
      <div className={styles.header}>
        <span className={styles.logo}>AI Agent</span>
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

export default Sidebar
