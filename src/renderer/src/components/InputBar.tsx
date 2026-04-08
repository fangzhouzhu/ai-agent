import React, { useState, useRef, useCallback } from 'react'
import styles from './InputBar.module.css'

interface RagFileMeta {
  id: string
  name: string
  path: string
  chunks: number
  uploadedAt: number
}

interface Props {
  onSend: (message: string, useAgent: boolean) => void
  onAbort: () => void
  isLoading: boolean
  isRagProcessing: boolean
  ragStatusText: string
  useAgent: boolean
  onToggleAgent: () => void
  ragFiles: RagFileMeta[]
  onPickFiles: () => void | Promise<void>
  onRemoveFile: (id: string) => void | Promise<void>
}

const InputBar: React.FC<Props> = ({
  onSend,
  onAbort,
  isLoading,
  isRagProcessing,
  ragStatusText,
  useAgent,
  onToggleAgent,
  ragFiles,
  onPickFiles,
  onRemoveFile,
}) => {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isBusy = isLoading || isRagProcessing

  const handleSend = useCallback(() => {
    const msg = input.trim()
    if (!msg || isBusy) return
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    onSend(msg, useAgent)
  }, [input, isBusy, onSend, useAgent])

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

  const placeholder =
    isRagProcessing
      ? '文档正在分析中，请稍候，完成后即可提问...'
      : ragFiles.length > 0
        ? '基于已上传文档提问，例如：总结重点、提取结论、解释某一段...'
        : useAgent
          ? '输入消息，或告诉我操作哪个文件...'
          : '输入消息...'

  return (
    <div className={styles.container}>
      <div className={styles.inner}>
        <div className={styles.toolbar}>
          <div className={styles.toolbarLeft}>
            <button
              className={`${styles.agentToggle} ${useAgent ? styles.agentActive : ''}`}
              onClick={onToggleAgent}
              title={useAgent ? '已启用文件工具，点击关闭' : '点击启用文件工具'}
            >
              <span>⚙</span>
              <span>{useAgent ? 'Agent 模式' : '普通对话'}</span>
            </button>

            <button
              className={styles.uploadBtn}
              onClick={() => void onPickFiles()}
              disabled={isBusy}
              title="上传文档用于 RAG 分析"
            >
              <span>📎</span>
              <span>上传文档</span>
            </button>
          </div>

          <span className={styles.hint}>按 Enter 发送，Shift+Enter 换行</span>
        </div>

        {(isRagProcessing || ragFiles.length > 0) && (
          <div className={styles.fileList}>
            {isRagProcessing && (
              <div className={styles.processingNotice}>
                <span className={styles.processingSpinner} />
                <span>{ragStatusText || '正在分析文档，请稍候...'}</span>
              </div>
            )}

            {ragFiles.map((file) => (
              <div key={file.id} className={styles.fileChip} title={`${file.name} · ${file.chunks} 个片段`}>
                <span className={styles.fileName}>{file.name}</span>
                <button
                  className={styles.fileRemove}
                  onClick={() => void onRemoveFile(file.id)}
                  title="移除该文档"
                  disabled={isRagProcessing}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <div className={styles.inputRow}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={1}
          />
          {isLoading ? (
            <button className={styles.stopBtn} onClick={onAbort} title="停止生成">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!input.trim() || isBusy}
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
