import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { WechatBotMessage, WechatBotStatus } from '../../../preload/index'
import type { Message } from '../types/conversation'
import MessageBubble from './MessageBubble'
import styles from './WechatBotPanel.module.css'

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

function toChatMessage(message: WechatBotMessage): Message | null {
  if (message.role === 'system') return null

  return {
    id: message.id,
    role: message.role,
    content: message.text,
    toolCalls: message.toolCalls,
    toolResults: message.toolResults,
    modelInfo: message.modelInfo,
    durationMs: message.durationMs,
    isStreaming: message.isStreaming,
    isError: message.status === 'error',
  }
}

const WechatBotPanel: React.FC<Props> = ({ onOpenSettings }) => {
  const [status, setStatus] = useState<WechatBotStatus | null>(null)
  const [messages, setMessages] = useState<WechatBotMessage[]>([])
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
      setMessages(nextMessages)
    }

    void load()
    const remove = window.electronAPI.onWechatBotUpdate((data) => {
      setStatus(data.status)
      setMessages(data.messages)
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
  const renderedMessages = useMemo(
    () =>
      messages.map((message) => ({
        raw: message,
        chat: toChatMessage(message),
      })),
    [messages]
  )
  const lastUserIdx = useMemo(
    () => renderedMessages.reduce((acc, item, itemIndex) => (item.chat?.role === 'user' ? itemIndex : acc), -1),
    [renderedMessages]
  )
  const lastAiIdx = useMemo(
    () =>
      renderedMessages.reduce(
        (acc, item, itemIndex) => (item.chat?.role === 'assistant' ? itemIndex : acc),
        -1
      ),
    [renderedMessages]
  )

  return (
    <div className={styles.container}>
      <header className={styles.topbar}>
        <div>
          <h2>微信 ClawBot</h2>
          <p>这里会同步展示微信 ClawBot 的消息，以及 Centibot 按同一套聊天界面呈现的处理结果。</p>
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
        {renderedMessages.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>等待微信消息</div>
            <div className={styles.emptyText}>
              用户不能在这里手动输入，消息会在微信 ClawBot 对话发生后自动同步到这里。
            </div>
          </div>
        ) : (
          <div className={styles.messages}>
            {renderedMessages.map(({ raw, chat }, index) => {
              if (!chat) {
                return (
                  <div key={raw.id} className={styles.systemRow}>
                    <div
                      className={`${styles.systemBubble} ${
                        raw.status === 'error' ? styles.systemBubbleError : ''
                      }`}
                    >
                      {raw.text}
                    </div>
                  </div>
                )
              }

              return (
                <MessageBubble
                  key={chat.id}
                  message={chat}
                  isLoading={Boolean(chat.isStreaming)}
                  isLast={chat.role === 'user' ? index === lastUserIdx : index === lastAiIdx}
                  readOnly
                  onCopy={async (message) => {
                    try {
                      await navigator.clipboard.writeText(message.content)
                    } catch (error) {
                      console.error('复制微信消息失败', error)
                    }
                  }}
                  onEdit={() => {}}
                  onDelete={() => {}}
                  onRegenerate={() => {}}
                />
              )
            })}
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <footer className={styles.readonlyFooter}>
        微信消息到达后会自动显示在这里，并且复用和普通对话一致的模型、工具与展示逻辑。
      </footer>
    </div>
  )
}

export default WechatBotPanel
