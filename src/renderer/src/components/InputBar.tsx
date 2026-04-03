import React, { useState, useRef, useCallback } from 'react'
import styles from './InputBar.module.css'

interface Props {
  onSend: (message: string, useAgent: boolean) => void
  onAbort: () => void
  isLoading: boolean
  useAgent: boolean
  onToggleAgent: () => void
}

const InputBar: React.FC<Props> = ({ onSend, onAbort, isLoading, useAgent, onToggleAgent }) => {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg || isLoading) return
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(msg, useAgent)
  }, [input, isLoading, onSend, useAgent])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value)
    const el = textareaRef.current
    if (el) {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 200) + 'px'
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.inner}>
        {/* 工具开关 */}
        <div className={styles.toolbar}>
          <button
            className={`${styles.agentToggle} ${useAgent ? styles.agentActive : ''}`}
            onClick={onToggleAgent}
            title={useAgent ? '已启用文件工具，点击关闭' : '点击启用文件工具'}
          >
            <span>⚙</span>
            <span>{useAgent ? 'Agent 模式' : '普通对话'}</span>
          </button>
          <span className={styles.hint}>按 Enter 发送，Shift+Enter 换行</span>
        </div>

        {/* 输入框 */}
        <div className={styles.inputRow}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={useAgent ? '输入消息，或告诉我操作哪个文件...' : '输入消息...'}
            rows={1}
          />
          {isLoading ? (
            <button
              className={styles.stopBtn}
              onClick={onAbort}
              title="停止生成"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!input.trim()}
              title="发送 (Enter)"
            >
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default InputBar
