import React, { useEffect, useRef, useState } from 'react'
import type { WechatBotMessage, WechatBotStatus } from '../../../preload/index'
import styles from './WechatBotPanel.module.css'

type BotChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  isError?: boolean
}

const statusLabel: Record<WechatBotStatus['status'], string> = {
  idle: '未绑定',
  waiting_scan: '等待扫码',
  bound: '已绑定',
  error: '异常',
  unbound: '已解绑',
}

interface Props {
  onOpenSettings: () => void
}

function mapWechatMessage(message: WechatBotMessage): BotChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.text,
    createdAt: message.createdAt,
    isError: message.status === 'error',
  }
}

const WechatBotPanel: React.FC<Props> = ({ onOpenSettings }) => {
  const [status, setStatus] = useState<WechatBotStatus | null>(null)
  const [messages, setMessages] = useState<BotChatMessage[]>([])
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false

    const load = async () => {
      const [nextStatus, nextMessages] = await Promise.all([
        window.electronAPI.getWechatBotStatus(),
        window.electronAPI.listWechatBotMessages(),
      ])

      if (disposed) return
      setStatus(nextStatus)
      setMessages(nextMessages.map(mapWechatMessage))
    }

    void load()
    const remove = window.electronAPI.onWechatBotUpdate((data) => {
      setStatus(data.status)
      setMessages(data.messages.map(mapWechatMessage))
    })

    return () => {
      disposed = true
      remove()
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const isBound = status?.status === 'bound'

  return (
    <div className={styles.container}>
      <header className={styles.topbar}>
        <div>
          <h2>微信ClawBot</h2>
          <p>这里只显示微信 ClawBot 发来的消息和 Centibot 返回给微信的内容。</p>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.badge} ${isBound ? styles.badgeOn : ''}`}>
            {status ? statusLabel[status.status] : '加载中'}
          </span>
          <button className={styles.settingsBtn} onClick={onOpenSettings}>
            绑定设置
          </button>
        </div>
      </header>

      <main className={styles.chatArea}>
        {messages.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>等待微信消息</div>
            <div className={styles.emptyText}>
              用户不能在这里手动输入，消息会在微信 ClawBot 对话发生后自动同步到这里。
            </div>
          </div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`${styles.messageRow} ${message.role === 'user' ? styles.messageRowUser : ''}`}
            >
              <div
                className={`${styles.messageBubble} ${
                  message.role === 'user' ? styles.messageBubbleUser : ''
                } ${message.isError ? styles.messageBubbleError : ''} ${
                  message.role === 'system' ? styles.messageBubbleSystem : ''
                }`}
              >
                <div className={styles.messageMeta}>
                  <span>
                    {message.role === 'user'
                      ? '微信用户'
                      : message.role === 'assistant'
                        ? '大模型回复'
                        : '系统'}
                  </span>
                  <span>{new Date(message.createdAt).toLocaleTimeString('zh-CN')}</span>
                </div>
                <div className={styles.messageText}>{message.content}</div>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </main>

      <footer className={styles.readonlyFooter}>
        微信消息到达后会自动显示在这里，并由 Centibot 处理后回发给微信 ClawBot。
      </footer>
    </div>
  )
}

export default WechatBotPanel
