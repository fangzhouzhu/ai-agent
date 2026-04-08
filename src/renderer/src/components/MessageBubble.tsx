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

const TOOL_META: Record<string, { icon: string; label: string }> = {
  get_current_time: { icon: '🕒', label: '当前时间' },
  get_weather_current: { icon: '🌤', label: '天气查询' },
  currency_convert: { icon: '💱', label: '汇率换算' },
  web_search: { icon: '🔎', label: '联网搜索' },
  fetch_url: { icon: '🌐', label: '网页抓取' },
  calculator: { icon: '🧮', label: '计算器' },
  unit_convert: { icon: '📏', label: '单位换算' },
  read_file: { icon: '📄', label: '读取文件' },
  write_file: { icon: '✍️', label: '写入文件' },
  list_directory: { icon: '📁', label: '目录列表' },
  delete_file: { icon: '🗑️', label: '删除文件' },
  search_files: { icon: '🧭', label: '搜索文件' },
}

type DetailItem = { label: string; value: string }
type ToolTraceStep = {
  id: string
  title: string
  summary: string
  status: 'done' | 'running'
}

function parseDetailLines(text: string): DetailItem[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([^:：]+)[:：]\s*(.+)$/)
      return match ? { label: match[1].trim(), value: match[2].trim() } : null
    })
    .filter((item): item is DetailItem => item !== null)
}

function renderInputPreview(input: unknown) {
  if (input == null) return null

  if (typeof input === 'object' && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>)
    return (
      <div className={styles.toolChips}>
        {entries.map(([key, value]) => (
          <span key={key} className={styles.toolChip}>
            <span className={styles.toolChipLabel}>{key}</span>
            <span>{String(value)}</span>
          </span>
        ))}
      </div>
    )
  }

  return <code>{JSON.stringify(input, null, 2)}</code>
}

function renderFileList(items: Array<{ type: string; name: string; extra?: string }>) {
  return (
    <div className={styles.fileList}>
      {items.map((item, index) => (
        <div key={`${item.name}-${index}`} className={styles.fileRow}>
          <span className={styles.fileIcon}>{item.type === 'dir' ? '📁' : '📄'}</span>
          <div className={styles.fileMeta}>
            <div className={styles.fileName}>{item.name}</div>
            {item.extra && <div className={styles.fileExtra}>{item.extra}</div>}
          </div>
        </div>
      ))}
    </div>
  )
}

function summarizeInput(input: unknown): string {
  if (input == null) return '无输入参数'

  if (typeof input === 'object' && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>).slice(0, 3)
    return entries.map(([key, value]) => `${key}=${String(value)}`).join(' · ')
  }

  return String(input)
}

function summarizeResult(result?: string): string {
  if (!result) return '等待工具返回结果...'
  const firstLine = result
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)

  const summary = firstLine || result.trim()
  return summary.length > 90 ? `${summary.slice(0, 90)}…` : summary
}

function renderResultPreview(toolName: string, result: string) {
  const trimmed = result.trim()
  const detailItems = parseDetailLines(trimmed)

  if (toolName === 'web_search') {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const queryLine = lines.find((line) => /^搜索关键词[:：]/.test(line))
    const query = queryLine?.replace(/^搜索关键词[:：]\s*/, '')
    const searchItems = lines.reduce<Array<{ title: string; link?: string }>>((acc, line, index) => {
      const matched = line.match(/^\d+\.\s+(.+)$/)
      if (!matched) return acc
      const nextLine = lines[index + 1]
      acc.push({
        title: matched[1],
        link: nextLine?.startsWith('http') ? nextLine : undefined,
      })
      return acc
    }, [])

    if (searchItems.length > 0) {
      return (
        <div className={styles.searchResultList}>
          {query && <div className={styles.searchQuery}>关键词：{query}</div>}
          {searchItems.map((item, index) => (
            <div key={`${item.title}-${index}`} className={styles.searchResultItem}>
              <div className={styles.searchResultTitle}>{item.title}</div>
              {item.link && <div className={styles.searchResultLink}>{item.link}</div>}
            </div>
          ))}
        </div>
      )
    }
  }

  if (toolName === 'calculator') {
    const matched = trimmed.match(/^计算结果[:：]\s*(.+?)\s*=\s*(.+)$/)
    if (matched) {
      return (
        <div className={styles.fileActionCard}>
          <div className={styles.fileActionTitle}>计算结果</div>
          <div className={styles.fileActionPath}>{matched[1]} = {matched[2]}</div>
        </div>
      )
    }
  }

  if (toolName === 'read_file') {
    const matched = trimmed.match(/^文件读取成功\s*\((\d+)\s*行\):\s*```([\s\S]*?)```$/)
    if (matched) {
      const [, lineCount, content] = matched
      return (
        <div className={styles.filePreviewCard}>
          <div className={styles.filePreviewHeader}>
            <span>已读取文件内容</span>
            <span>{lineCount} 行</span>
          </div>
          <pre className={styles.fileContentPreview}>{content.trim()}</pre>
        </div>
      )
    }
  }

  if (toolName === 'write_file' || toolName === 'delete_file') {
    const matched = trimmed.match(/^(文件(?:写入|删除)成功)[:：]\s*(.+)$/)
    if (matched) {
      return (
        <div className={styles.fileActionCard}>
          <div className={styles.fileActionTitle}>{matched[1]}</div>
          <div className={styles.fileActionPath}>{matched[2]}</div>
        </div>
      )
    }
  }

  if (toolName === 'list_directory') {
    const dirMatch = trimmed.match(/^目录\s+"(.+?)"\s+的内容[:：]?/)
    const items = trimmed
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const itemMatch = line.match(/^\[(目录|文件)\]\s+(.+?)(?:\s+\((.+)\))?$/)
        if (!itemMatch) return null
        return {
          type: itemMatch[1] === '目录' ? 'dir' : 'file',
          name: itemMatch[2],
          extra: itemMatch[3],
        }
      })
      .filter((item): item is { type: string; name: string; extra?: string } => item !== null)

    if (items.length > 0) {
      return (
        <div className={styles.filePreviewCard}>
          {dirMatch && <div className={styles.filePreviewHeader}><span>目录</span><span>{dirMatch[1]}</span></div>}
          {renderFileList(items)}
        </div>
      )
    }
  }

  if (toolName === 'search_files') {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    const header = lines[0]
    const items = lines.slice(1).map((line) => ({
      type: 'file',
      name: line.split(/[\\/]/).pop() || line,
      extra: line,
    }))

    if (items.length > 0) {
      return (
        <div className={styles.filePreviewCard}>
          <div className={styles.filePreviewHeader}><span>搜索结果</span><span>{header}</span></div>
          {renderFileList(items)}
        </div>
      )
    }
  }

  if (toolName === 'get_weather_current' && detailItems.length >= 2) {
    const weather = Object.fromEntries(detailItems.map((item) => [item.label, item.value]))
    const summaryItems = detailItems.filter((item) => !['位置', '天气', '温度'].includes(item.label))

    return (
      <div className={styles.weatherPanel}>
        <div className={styles.weatherHero}>
          <div>
            <div className={styles.weatherTitle}>{weather['天气'] || '当前天气'}</div>
            <div className={styles.weatherTemp}>{weather['温度'] || '--'}</div>
          </div>
          <div className={styles.weatherLocation}>{weather['位置'] || '未知地点'}</div>
        </div>
        <div className={styles.toolResultGrid}>
          {summaryItems.map((item) => (
            <div key={item.label} className={styles.toolResultRow}>
              <span className={styles.toolResultKey}>{item.label}</span>
              <span className={styles.toolResultValue}>{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (detailItems.length >= 2) {
    return (
      <div className={styles.toolResultGrid}>
        {detailItems.map((item) => (
          <div key={item.label} className={styles.toolResultRow}>
            <span className={styles.toolResultKey}>{item.label}</span>
            <span className={styles.toolResultValue}>{item.value}</span>
          </div>
        ))}
      </div>
    )
  }

  return <pre className={styles.toolResultBlock}>{trimmed}</pre>
}

const ToolCallBadge: React.FC<{ toolName: string; input: unknown; result?: string }> = ({
  toolName,
  input,
  result
}) => {
  const meta = TOOL_META[toolName] ?? { icon: '⚙', label: toolName }

  return (
    <div className={styles.toolCall}>
      <div className={styles.toolHeader}>
        <span className={styles.toolIcon}>{meta.icon}</span>
        <span className={styles.toolName}>{meta.label}</span>
        <span className={styles.toolRawName}>{toolName}</span>
      </div>
      {input !== undefined && (
        <div className={styles.toolDetail}>
          <span className={styles.toolLabel}>输入</span>
          {renderInputPreview(input)}
        </div>
      )}
      {result && (
        <div className={styles.toolDetail}>
          <span className={styles.toolLabel}>结果</span>
          {renderResultPreview(toolName, result)}
        </div>
      )}
    </div>
  )
}

const ToolProcessPanel: React.FC<{
  toolCalls: NonNullable<Message['toolCalls']>
  toolResults: NonNullable<Message['toolResults']>
  isStreaming: boolean
  scene?: string
}> = ({ toolCalls, toolResults, isStreaming, scene }) => {
  const [expanded, setExpanded] = React.useState(isStreaming)

  useEffect(() => {
    if (isStreaming) {
      setExpanded(true)
    } else {
      setExpanded(false)
    }
  }, [isStreaming])

  const steps = React.useMemo<ToolTraceStep[]>(() => {
    const analysisSummary =
      scene === '复杂任务'
        ? '正在分步骤分析问题，并判断是否需要调用工具辅助完成。'
        : scene === 'RAG'
          ? '正在结合已上传文档进行检索与整理。'
          : '已判断当前问题需要借助工具来获取更可靠的信息。'

    const traceSteps: ToolTraceStep[] = [
      {
        id: 'analysis',
        title: '分析请求',
        summary: analysisSummary,
        status: 'done',
      },
    ]

    if (toolCalls.length === 0) {
      traceSteps.push({
        id: 'thinking',
        title: scene === 'RAG' ? '检索上下文' : '思考处理中',
        summary: isStreaming
          ? scene === 'RAG'
            ? '正在检索相关片段并组织回答…'
            : '正在理解问题并规划处理步骤…'
          : scene === 'RAG'
            ? '已完成上下文整理。'
            : '已完成问题分析。',
        status: isStreaming ? 'running' : 'done',
      })
    }

    toolCalls.forEach((toolCall, index) => {
      const meta = TOOL_META[toolCall.toolName] ?? { icon: '⚙', label: toolCall.toolName }
      const result = toolResults[index]?.result

      traceSteps.push({
        id: `call-${index}`,
        title: `调用 ${meta.label}`,
        summary: summarizeInput(toolCall.input),
        status: result ? 'done' : 'running',
      })

      if (result) {
        traceSteps.push({
          id: `result-${index}`,
          title: `${meta.label} 返回结果`,
          summary: summarizeResult(result),
          status: 'done',
        })
      }
    })

    traceSteps.push({
      id: 'final',
      title: '整理最终回答',
      summary:
        toolCalls.length > 0
          ? isStreaming
            ? '正在整合工具结果并生成回复…'
            : '已完成回复整理。'
          : isStreaming
            ? '正在生成回复内容…'
            : '已完成回复生成。',
      status: isStreaming ? 'running' : 'done',
    })

    return traceSteps
  }, [toolCalls, toolResults, isStreaming])

  return (
    <div className={styles.processPanel}>
      <button
        className={styles.processHeader}
        onClick={() => setExpanded((prev) => !prev)}
        title={expanded ? '收起执行过程' : '展开执行过程'}
      >
        <span className={styles.processTitleWrap}>
          <span className={styles.processIcon}>{isStreaming ? '🧠' : '🪄'}</span>
          <span className={styles.processTitle}>思考与执行过程</span>
          <span className={styles.processCount}>{steps.length} 步</span>
        </span>
        <span className={styles.processToggle} aria-hidden="true">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <div className={styles.processBody}>
          <div className={styles.timeline}>
            {steps.map((step) => (
              <div key={step.id} className={styles.timelineItem}>
                <span
                  className={`${styles.timelineDot} ${
                    step.status === 'running' ? styles.timelineDotRunning : styles.timelineDotDone
                  }`}
                />
                <div className={styles.timelineContent}>
                  <div className={styles.timelineTitle}>{step.title}</div>
                  <div className={styles.timelineSummary}>{step.summary}</div>
                </div>
              </div>
            ))}
          </div>

          <div className={styles.processDetails}>
            {toolCalls.map((toolCall, index) => (
              <ToolCallBadge
                key={`${toolCall.toolName}-${index}`}
                toolName={toolCall.toolName}
                input={toolCall.input}
                result={toolResults[index]?.result}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

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

const CodeBlockWithCopy: React.FC<{
  language: string
  code: string
}> = ({ language, code }) => {
  const [copied, setCopied] = React.useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch (error) {
      console.error('复制代码失败', error)
    }
  }

  return (
    <div className={styles.codeBlockWithCopy}>
      <div className={styles.codeBlockToolbar}>
        <span className={styles.codeBlockLang}>{language}</span>
        <button
          type="button"
          className={`${styles.codeCopyBtn} ${copied ? styles.codeCopyBtnSuccess : ''}`}
          onClick={handleCopy}
          title="复制代码"
          aria-label="复制代码"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark as any}
        language={language}
        PreTag="div"
        customStyle={{ margin: 0, borderRadius: '0 0 8px 8px', fontSize: '0.9em' }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

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

  const shouldShowProcessPanel =
    !isUser &&
    ((message.toolCalls?.length ?? 0) > 0 ||
      ['Agent/工具', '复杂任务', 'RAG'].includes(message.modelInfo?.scene ?? ''))

  return (
    <div className={`${styles.wrapper} ${isUser ? styles.userWrapper : styles.assistantWrapper}`}>
      {/* 头像 */}
      <div className={`${styles.avatar} ${isUser ? styles.userAvatar : styles.aiAvatar}`}>
        {isUser ? 'U' : 'AI'}
      </div>

      <div className={styles.content}>
        {/* 工具执行过程 */}
        {shouldShowProcessPanel && (
          <ToolProcessPanel
            toolCalls={message.toolCalls ?? []}
            toolResults={message.toolResults ?? []}
            isStreaming={Boolean(message.isStreaming)}
            scene={message.modelInfo?.scene}
          />
        )}

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
                  a({ href, children, ...props }) {
                    return (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(event) => {
                          event.preventDefault()
                          if (href) {
                            window.open(href, '_blank', 'noopener,noreferrer')
                          }
                        }}
                        {...props}
                      >
                        {children}
                      </a>
                    )
                  },
                  code({ className, children, ...props }) {
                    const match = /language-(\w+)/.exec(className || '')
                    const code = String(children).replace(/\n$/, '')

                    if (!match) {
                      return (
                        <code className={className} {...props}>
                          {children as ReactNode}
                        </code>
                      )
                    }

                    return (
                      <CodeBlockWithCopy language={match[1]} code={code} />
                    )
                  }
                }}
              >
                {message.content || ' '}
              </ReactMarkdown>
            </div>
          )}
        </div>

        {!isUser && message.modelInfo && (
          <div className={styles.metaInfo}>
            <span className={styles.metaChip}>
              <span className={styles.metaLabel}>模型</span>
              <span>{message.modelInfo.model}</span>
            </span>
            <span className={`${styles.metaChip} ${styles.sceneChip}`}>
              <span className={styles.metaLabel}>场景</span>
              <span>{message.modelInfo.scene}</span>
            </span>
            {message.modelInfo.skill && (
              <span className={styles.metaChip}>
                <span className={styles.metaLabel}>技能</span>
                <span>{message.modelInfo.skill}</span>
              </span>
            )}
          </div>
        )}

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
