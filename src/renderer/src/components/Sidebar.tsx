import React, { useCallback } from 'react'
import type { Conversation } from '../types/conversation'
import styles from './Sidebar.module.css'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
  currentView: 'chat' | 'kb' | 'task' | 'skills' | 'wechat'
  onViewChange: (view: 'chat' | 'kb' | 'task' | 'skills' | 'wechat') => void
  selectedKbCount: number
  runningTaskCount: number
  onSelectKb: (id: string | null) => void
  onSelectTask: (id: string | null) => void
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
  onSelectKb,
  onSelectTask,
}) => {
  const handleNewChat = useCallback(() => {
    onNew()
    onViewChange('chat')
  }, [onNew, onViewChange])

  const sortedConversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <button className={styles.brandBtn} onClick={() => onViewChange('chat')}>
          <span className={styles.logoMark} aria-hidden="true" />
          <span className={styles.logo}>Centibot</span>
        </button>
      </div>

      <div className={styles.scrollArea}>
        <nav className={styles.primaryNav}>
          <button className={`${styles.navItem} ${styles.newChatBtn}`} onClick={handleNewChat}>
            <span className={styles.navIcon}>+</span>
            <span>新对话</span>
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'wechat' ? styles.navItemActive : ''}`}
            onClick={() => onViewChange('wechat')}
          >
            <span className={styles.navIcon}>微</span>
            <span>微信ClawBot</span>
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'kb' ? styles.navItemActive : ''}`}
            onClick={() => {
              onSelectKb(null)
              onViewChange('kb')
            }}
          >
            <span className={styles.navIcon}>□</span>
            <span>知识库</span>
            {selectedKbCount > 0 && <span className={styles.countBadge}>{selectedKbCount}</span>}
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'task' ? styles.navItemActive : ''}`}
            onClick={() => {
              onSelectTask(null)
              onViewChange('task')
            }}
          >
            <span className={styles.navIcon}>◇</span>
            <span>任务</span>
            {runningTaskCount > 0 && <span className={styles.countBadge}>{runningTaskCount}</span>}
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'skills' ? styles.navItemActive : ''}`}
            onClick={() => onViewChange('skills')}
          >
            <span className={styles.navIcon}>✦</span>
            <span>Skills</span>
          </button>
        </nav>

        <section className={styles.section}>
          <div className={styles.sectionTitle}>最近</div>
          {sortedConversations.length === 0 ? (
            <div className={styles.emptyText}>暂无对话记录</div>
          ) : (
            <div className={styles.list}>
              {sortedConversations.map((conv) => (
                <button
                  key={conv.id}
                  className={`${styles.listItem} ${
                    currentView === 'chat' && conv.id === activeId ? styles.active : ''
                  }`}
                  onClick={() => onSelect(conv.id)}
                  title={conv.title}
                >
                  <span className={styles.itemIcon}>☰</span>
                  <span className={styles.itemTitle}>{conv.title}</span>
                  <span
                    className={styles.deleteBtn}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDelete(conv.id)
                    }}
                    title="删除"
                    aria-label="删除"
                  >
                    ×
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>

      <div className={styles.footer}>
        <div className={styles.userAvatar}>C</div>
        <div className={styles.footerText}>
          <span>Centibot</span>
          <small>专业 · 智能 · 高效</small>
        </div>
        <button className={styles.settingsBtn} onClick={onOpenSettings} title="打开设置" aria-label="打开设置">
          ⚙
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
