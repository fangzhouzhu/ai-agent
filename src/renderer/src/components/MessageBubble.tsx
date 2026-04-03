import React, { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { Message } from '../types/conversation'
import type { ReactNode } from 'react'
import styles from './MessageBubble.module.css'

interface Props {
  message: Message
  isLoading: boolean
  onCopy: (message: Message) => void
  onEdit: (messageId: string, content: string) => void
  onDelete: (messageId: string) => void
  onRegenerate: (messageId: string) => void
}

const ToolCallBadge: React.FC<{ toolName: string; input: unknown; result?: string }> = ({
  toolName,
  input,
  result
}) => (
  <div className={styles.toolCall}>
    <div className={styles.toolHeader}>
      <span className={styles.toolIcon}>⚙</span>
      <span className={styles.toolName}>{toolName}</span>
    </div>
    {input !== undefined && (
      <div className={styles.toolDetail}>
        <span className={styles.toolLabel}>输入：</span>
        <code>{JSON.stringify(input, null, 2)}</code>
      </div>
    )}
    {result && (
      <div className={styles.toolDetail}>
        <span className={styles.toolLabel}>结果：</span>
        <span className={styles.toolResult}>{result.slice(0, 200)}{result.length > 200 ? '…' : ''}</span>
      </div>
    )}
  </div>
)

const CopyIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
)

const EditIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5z" />
  </svg>
)

const DeleteIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18" />
    <path d="M8 6V4h8v2" />
    <path d="M19 6l-1 14H6L5 6" />
    <path d="M10 11v6" />
    <path d="M14 11v6" />
  </svg>
)

const RegenerateIcon: React.FC = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </svg>
)

const MessageBubble: React.FC<Props> = ({
  message,
  isLoading,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
}) => {
  const isUser = message.role === 'user'
  const cursorRef = useRef<HTMLSpanElement>(null)
  const [isEditing, setIsEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(message.content)

  useEffect(() => {
    setDraft(message.content)
  }, [message.content])

  useEffect(() => {
    if (!message.isStreaming && cursorRef.current) {
      cursorRef.current.style.display = 'none'
    }
  }, [message.isStreaming])

  const handleSave = () => {
    const next = draft.trim()
    if (!next) return
    onEdit(message.id, next)
    setIsEditing(false)
  }

  return (
    <div className={`${styles.wrapper} ${isUser ? styles.userWrapper : styles.assistantWrapper}`}>
      {/* 头像 */}
      <div className={`${styles.avatar} ${isUser ? styles.userAvatar : styles.aiAvatar}`}>
        {isUser ? 'U' : 'AI'}
      </div>

      <div className={styles.content}>
        {/* 工具调用展示 */}
        {(message.toolCalls ?? []).map((tc, i) => (
          <ToolCallBadge
            key={i}
            toolName={tc.toolName}
            input={tc.input}
            result={message.toolResults?.[i]?.result}
          />
        ))}

        {/* 消息内容 */}
        <div className={`${styles.bubble} ${isUser ? styles.userBubble : styles.aiBubble} ${message.isError ? styles.errorBubble : ''}`}>
          {isUser ? (
            isEditing ? (
              <div className={styles.editBox}>
                <textarea
                  className={styles.editInput}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  disabled={isLoading}
                />
                <div className={styles.editActions}>
                  <button
                    className={styles.actionBtn}
                    onClick={() => {
                      setDraft(message.content)
                      setIsEditing(false)
                    }}
                    disabled={isLoading}
                  >
                    取消
                  </button>
                  <button className={styles.actionBtn} onClick={handleSave} disabled={isLoading || !draft.trim()}>
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <pre className={styles.userText}>{message.content}</pre>
            )
          ) : message.isStreaming ? (
            <pre className={styles.assistantText}>
              {message.content || ' '}
              <span ref={cursorRef} className={styles.cursor} />
            </pre>
          ) : (
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '')
                    const isInline = !match
                    return isInline ? (
                      <code className={className} {...props}>
                        {children as ReactNode}
                      </code>
                    ) : (
                      <SyntaxHighlighter
                        style={oneDark as any}
                        language={match[1]}
                        PreTag="div"
                        customStyle={{ margin: 0, borderRadius: '8px', fontSize: '0.9em' }}
                      >
                        {String(children).replace(/\n$/, '')}
                      </SyntaxHighlighter>
                    )
                  }
                }}
              >
                {message.content || ' '}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {!isEditing && (
          <div className={styles.actions}>
            <button className={styles.actionBtn} onClick={() => onCopy(message)} title="复制消息" aria-label="复制消息">
              <CopyIcon />
            </button>
            {isUser ? (
              <>
                <button className={styles.actionBtn} onClick={() => setIsEditing(true)} disabled={isLoading} title="编辑消息" aria-label="编辑消息">
                  <EditIcon />
                </button>
                <button
                  className={`${styles.actionBtn} ${styles.dangerBtn}`}
                  onClick={() => onDelete(message.id)}
                  disabled={isLoading}
                  title="删除消息"
                  aria-label="删除消息"
                >
                  <DeleteIcon />
                </button>
              </>
            ) : (
              <button className={styles.actionBtn} onClick={() => onRegenerate(message.id)} disabled={isLoading} title="重新生成" aria-label="重新生成">
                <RegenerateIcon />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default React.memo(MessageBubble)
