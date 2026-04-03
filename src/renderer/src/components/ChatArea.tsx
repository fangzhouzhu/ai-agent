import React, { useEffect, useRef } from 'react'
import type { Message } from '../types/conversation'
import MessageBubble from './MessageBubble'
import styles from './ChatArea.module.css'

interface Props {
  messages: Message[]
  isLoading: boolean
}

const WelcomeScreen: React.FC = () => (
  <div className={styles.welcome}>
    <div className={styles.welcomeIcon}>🤖</div>
    <h1 className={styles.welcomeTitle}>AI Agent</h1>
    <p className={styles.welcomeSubtitle}>基于 Ollama 的本地智能助手，支持文件操作与内容分析</p>
    <div className={styles.features}>
      <div className={styles.feature}>
        <span>💬</span>
        <span>自然语言对话</span>
      </div>
      <div className={styles.feature}>
        <span>📁</span>
        <span>读写本地文件</span>
      </div>
      <div className={styles.feature}>
        <span>🔍</span>
        <span>文件内容分析</span>
      </div>
      <div className={styles.feature}>
        <span>⚡</span>
        <span>完全本地运行</span>
      </div>
    </div>
  </div>
)

const ChatArea: React.FC<Props> = ({ messages, isLoading }) => {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, isLoading])

  return (
    <div className={styles.container}>
      <div className={styles.scroll}>
        {messages.length === 0 ? (
          <WelcomeScreen />
        ) : (
          <div className={styles.messages}>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
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
    </div>
  )
}

export default ChatArea
