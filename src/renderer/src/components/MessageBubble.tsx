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

const MessageBubble: React.FC<Props> = ({ message }) => {
  const isUser = message.role === 'user'
  const cursorRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!message.isStreaming && cursorRef.current) {
      cursorRef.current.style.display = 'none'
    }
  }, [message.isStreaming])

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
            <pre className={styles.userText}>{message.content}</pre>
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
              {message.isStreaming && (
                <span ref={cursorRef} className={styles.cursor} />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default MessageBubble
