import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Conversation } from '../types/conversation'
import styles from './Sidebar.module.css'
import { useAppDialog } from './AppDialogProvider'

type AgentSummary = {
  id: string
  name: string
  avatar?: string
}

interface Props {
  conversations: Conversation[]
  agents: AgentSummary[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void | Promise<void>
  onOpenSettings: () => void
  currentView: 'chat' | 'agents' | 'kb' | 'skills' | 'wechat'
  onViewChange: (view: 'chat' | 'agents' | 'kb' | 'skills' | 'wechat') => void
  runningTaskCount: number
  activeKbId?: string | null
  onSelectKb: (id: string | null) => void
}

function getAgentTextLogo(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'AI'

  const alphaNumeric = trimmed.match(/[A-Za-z0-9]+/g)
  if (alphaNumeric && alphaNumeric.length > 0) {
    return alphaNumeric
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase()
  }

  return trimmed.slice(0, 2).toUpperCase()
}

const MessageBubbleIcon: React.FC = () => (
  <svg
    className={styles.defaultBubbleIcon}
    viewBox="0 0 20 20"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <path
      d="M5.2 4.75H14.8C16.01 4.75 17 5.74 17 6.95V10.6C17 11.81 16.01 12.8 14.8 12.8H9.45L7 14.8V12.8H5.2C3.99 12.8 3 11.81 3 10.6V6.95C3 5.74 3.99 4.75 5.2 4.75Z"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinejoin="round"
    />
    <circle cx="7.35" cy="8.8" r="0.75" fill="currentColor" />
    <circle cx="10" cy="8.8" r="0.75" fill="currentColor" />
    <circle cx="12.65" cy="8.8" r="0.75" fill="currentColor" />
  </svg>
)

const NewChatIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path d="M8 3.25V12.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M3.25 8H12.75" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

const Sidebar: React.FC<Props> = ({
  conversations,
  agents,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onRename,
  onOpenSettings,
  currentView,
  onViewChange,
  runningTaskCount,
  onSelectKb,
}) => {
  const { confirm, prompt } = useAppDialog()
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  const handleNewChat = useCallback(() => {
    onNew()
    onViewChange('chat')
  }, [onNew, onViewChange])

  const sortedConversations = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)
  const agentMap = new Map(agents.map((agent) => [agent.id, agent]))

  useEffect(() => {
    if (!menuOpenId) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpenId(null)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [menuOpenId])

  return (
    <aside className={styles.sidebar}>
      <div className={styles.header}>
        <button className={styles.brandBtn} onClick={() => onViewChange('chat')}>
          <span className={styles.logoMark} aria-hidden="true" />
          <span className={styles.logo}>Centibot</span>
          {runningTaskCount > 0 && <span className={styles.countBadge}>{runningTaskCount}</span>}
        </button>
      </div>

      <div className={styles.scrollArea}>
        <nav className={styles.primaryNav}>
          <button className={`${styles.navItem} ${styles.newChatBtn}`} onClick={handleNewChat}>
            <span className={styles.navIcon}>
              <NewChatIcon />
            </span>
            <span>新对话</span>
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'agents' ? styles.navItemActive : ''}`}
            onClick={() => onViewChange('agents')}
          >
            <span className={styles.navIcon}>◎</span>
            <span>智能体</span>
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'wechat' ? styles.navItemActive : ''}`}
            onClick={() => onViewChange('wechat')}
          >
            <span className={styles.navIcon}>微</span>
            <span>微信 ClawBot</span>
          </button>
          <button
            className={`${styles.navItem} ${currentView === 'kb' ? styles.navItemActive : ''}`}
            onClick={() => {
              onSelectKb(null)
              onViewChange('kb')
            }}
          >
            <span className={styles.navIcon}>▣</span>
            <span>知识库</span>
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
          <div className={styles.sectionBody}>
            <div className={styles.sectionContent}>
              {sortedConversations.length === 0 ? (
                <div className={styles.emptyText}>暂无对话记录</div>
              ) : (
                <div className={styles.list}>
                  {sortedConversations.map((conv) => {
                    const agent = conv.agentProfileId ? agentMap.get(conv.agentProfileId) : null
                    const agentLogo = agent ? (agent.avatar?.trim() || getAgentTextLogo(agent.name)) : null

                    return (
                      <div
                        key={conv.id}
                        className={`${styles.listItem} ${
                          currentView === 'chat' && conv.id === activeId ? styles.active : ''
                        }`}
                        onClick={() => onSelect(conv.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onSelect(conv.id)
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        title={agent ? `${agent.name} · ${conv.title}` : conv.title}
                      >
                        <span
                          className={`${styles.itemBadge} ${
                            agent ? styles.itemBadgeAgent : styles.itemBadgeDefault
                          }`}
                          aria-hidden="true"
                        >
                          {agent ? (
                            <span className={styles.itemBadgeText}>{agentLogo}</span>
                          ) : (
                            <MessageBubbleIcon />
                          )}
                        </span>
                        <span className={styles.itemTitle}>{conv.title}</span>
                        <div className={styles.itemMenuWrap} ref={menuOpenId === conv.id ? menuRef : null}>
                          <button
                            type="button"
                            className={`${styles.itemMenuBtn} ${menuOpenId === conv.id ? styles.itemMenuBtnVisible : ''}`}
                            onClick={(e) => {
                              e.stopPropagation()
                              setMenuOpenId((prev) => (prev === conv.id ? null : conv.id))
                            }}
                            title="更多操作"
                            aria-label="更多操作"
                          >
                            ...
                          </button>
                          {menuOpenId === conv.id && (
                            <div className={styles.itemMenuDropdown} onClick={(e) => e.stopPropagation()}>
                              <button
                                type="button"
                                className={styles.itemMenuAction}
                                onClick={async () => {
                                  const nextTitle = await prompt({
                                    title: '编辑对话名称',
                                    initialValue: conv.title,
                                    placeholder: '请输入新的对话名称',
                                  })
                                  if (nextTitle && nextTitle.trim()) {
                                    await onRename(conv.id, nextTitle)
                                  }
                                  setMenuOpenId(null)
                                }}
                              >
                                重命名
                              </button>
                              <button
                                type="button"
                                className={`${styles.itemMenuAction} ${styles.itemMenuActionDanger}`}
                                onClick={async () => {
                                  if (
                                    await confirm({
                                      title: '确认删除对话？',
                                      message: `删除后，“${conv.title}”聊天记录将不可恢复。`,
                                      confirmText: '删除',
                                      tone: 'danger',
                                    })
                                  ) {
                                    onDelete(conv.id)
                                  }
                                  setMenuOpenId(null)
                                }}
                              >
                                删除
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      <div className={styles.footer}>
        <div className={styles.userAvatar}>C</div>
        <button
          className={styles.settingsBtn}
          type="button"
          onClick={onOpenSettings}
          title="打开设置"
          aria-label="打开设置"
        >
          ⚙
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
