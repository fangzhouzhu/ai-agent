import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { Message } from '../types/conversation'
import MessageBubble from './MessageBubble'
import styles from './ChatArea.module.css'

interface Props {
  messages: Message[]
  isLoading: boolean
  onCopyMessage: (message: Message) => void
  onEditUserMessage: (messageId: string, content: string) => void
  onDeleteMessage: (messageId: string) => void
  onRegenerateMessage: (messageId: string) => void
}

const WelcomeScreen: React.FC = () => (
  <div className={styles.welcome}>
    <div className={styles.welcomeIcon}>�</div>
    <div className={styles.welcomeBadge}>Local Workspace</div>
    <h1 className={styles.welcomeTitle}>开始一个新会话</h1>
    <p className={styles.welcomeSubtitle}>
      在这里可以处理文档、调用工具、切换模型，完成日常整理与分析工作。
    </p>
    <div className={styles.features}>
      <div className={styles.feature}>
        <strong>对话整理</strong>
        <span>总结、改写、问答</span>
      </div>
      <div className={styles.feature}>
        <strong>文档分析</strong>
        <span>上传文件后提取重点</span>
      </div>
      <div className={styles.feature}>
        <strong>工具操作</strong>
        <span>文件、搜索、计算等</span>
      </div>
      <div className={styles.feature}>
        <strong>模型切换</strong>
        <span>本地与在线预设可选</span>
      </div>
    </div>
  </div>
)

const ChatArea: React.FC<Props> = ({
  messages,
  isLoading,
  onCopyMessage,
  onEditUserMessage,
  onDeleteMessage,
  onRegenerateMessage,
}) => {
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottomRef = useRef(true)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)

  const updateScrollState = useCallback(() => {
    const container = scrollRef.current
    if (!container) return

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight
    const nearBottom = distanceFromBottom < 120

    isNearBottomRef.current = nearBottom
    setShowScrollToBottom(messages.length > 0 && !nearBottom)
  }, [messages.length])

  const handleScrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [])

  useEffect(() => {
    if (isNearBottomRef.current) {
      bottomRef.current?.scrollIntoView({
        behavior: isLoading ? 'auto' : 'smooth',
        block: 'end',
      })
    }
    updateScrollState()
  }, [messages, isLoading, updateScrollState])

  return (
    <div className={styles.container}>
      <div ref={scrollRef} className={styles.scroll} onScroll={updateScrollState}>
        {messages.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <div className={styles.messages}>
            {messages.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isLoading={isLoading}
                onCopy={onCopyMessage}
                onEdit={onEditUserMessage}
                onDelete={onDeleteMessage}
                onRegenerate={onRegenerateMessage}
              />
            ))}
            {isLoading && messages[messages.length - 1]?.role === 'user' && (
              <div className={styles.thinkingWrapper}>
                <div className={styles.thinkingDots}>
                  <span /><span /><span />
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {showScrollToBottom && (
        <button
          type="button"
          className={styles.scrollToBottomBtn}
          onClick={handleScrollToBottom}
          title="滚动到最新消息"
          aria-label="滚动到最新消息"
        >
          <span className={styles.scrollToBottomIcon}>↓</span>
        </button>
      )}
    </div>
  )
}

export default ChatArea
