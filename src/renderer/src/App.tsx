import React, { useState, useEffect, useCallback, useRef } from 'react'
import Sidebar from './components/Sidebar'
import ChatArea from './components/ChatArea'
import InputBar from './components/InputBar'
import {
  type Conversation,
  type ConvMeta,
  type Message,
  createConversation,
  createMessage,
  generateTitle,
  toStoredMessage,
} from './types/conversation'
import { v4 as uuidv4 } from 'uuid'
import styles from './App.module.css'

const App: React.FC = () => {
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [useAgent, setUseAgent] = useState(true)
  const [models, setModels] = useState<string[]>([])
  const [currentModel, setCurrentModel] = useState('qwen2.5:7b')

  const streamingMsgIdRef = useRef<string | null>(null)
  const tokenQueueRef = useRef('')
  const typingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const typingTargetRef = useRef<{ convId: string; msgId: string } | null>(null)

  // 初始化：从文件加载索引
  useEffect(() => {
    const init = async () => {
      if (!window.electronAPI?.storage) {
        console.error('electronAPI.storage 未就绪，请重启应用')
        return
      }
      const [metas, activeIdStored] = await Promise.all([
        window.electronAPI.storage.list(),
        window.electronAPI.storage.getActive(),
      ])

      const convs: Conversation[] = metas.map((m) => ({
        ...m,
        messages: [],
        loaded: false,
      }))
      setConversations(convs)

      if (activeIdStored && metas.find((m) => m.id === activeIdStored)) {
        setActiveId(activeIdStored)
      } else if (metas.length > 0) {
        setActiveId(metas[0].id)
      }

      const [list, current] = await Promise.all([
        window.electronAPI.listModels(),
        window.electronAPI.getModel(),
      ])
      if (list.length > 0) setModels(list)
      setCurrentModel(current)
    }
    init()
  }, [])

  // 切换到某个对话时懒加载消息
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv || conv.loaded) return

    window.electronAPI.storage.load(activeId).then((storedMsgs) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? { ...c, messages: storedMsgs as Message[], loaded: true }
            : c
        )
      )
    })
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  // 持久化活跃 ID
  useEffect(() => {
    if (activeId) window.electronAPI.storage.setActive(activeId)
  }, [activeId])

  const activeConversation = conversations.find((c) => c.id === activeId) ?? null

  // 保存单条对话到磁盘
  const persistConversation = useCallback((conv: Conversation) => {
    const meta: ConvMeta = {
      id: conv.id,
      title: conv.title,
      createdAt: conv.createdAt,
      updatedAt: conv.updatedAt,
    }
    const messages = conv.messages
      .filter((m) => !m.isStreaming)
      .map(toStoredMessage)
    window.electronAPI.storage.save(meta, messages)
  }, [])

  // 新建对话
  const handleNew = useCallback(() => {
    const conv = createConversation()
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    window.electronAPI.storage.save(
      { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt },
      []
    )
  }, [])

  // 切换对话
  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
  }, [])

  // 删除对话
  const handleDelete = useCallback(
    (id: string) => {
      window.electronAPI.storage.delete(id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (activeId === id) {
        const remaining = conversations.filter((c) => c.id !== id)
        const nextId = remaining.length > 0 ? remaining[0].id : null
        setActiveId(nextId)
        if (nextId === null) window.electronAPI.storage.setActive(null)
      }
    },
    [activeId, conversations]
  )

  // 切换模型
  const handleModelChange = useCallback(async (model: string) => {
    setCurrentModel(model)
    await window.electronAPI.setModel(model)
  }, [])

  const appendToStreamingMessage = useCallback((convId: string, msgId: string, text: string) => {
    if (!text) return
    setConversations((prev) =>
      prev.map((c) =>
        c.id === convId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === msgId ? { ...m, content: m.content + text } : m
              ),
            }
          : c
      )
    )
  }, [])

  const flushTypingStep = useCallback(
    (convId: string, msgId: string) => {
      const pending = tokenQueueRef.current
      if (!pending) {
        if (typingTimerRef.current) {
          clearInterval(typingTimerRef.current)
          typingTimerRef.current = null
        }
        return
      }

      // 队列积压时自动提速，避免看起来“卡在后面慢慢打”。
      const charsPerStep =
        pending.length > 240 ? 48 : pending.length > 120 ? 24 : pending.length > 60 ? 12 : 4
      const chunk = pending.slice(0, charsPerStep)
      tokenQueueRef.current = pending.slice(charsPerStep)
      appendToStreamingMessage(convId, msgId, chunk)
    },
    [appendToStreamingMessage]
  )

  const ensureTypingLoop = useCallback(
    (convId: string, msgId: string) => {
      typingTargetRef.current = { convId, msgId }
      if (typingTimerRef.current) return

      typingTimerRef.current = setInterval(() => {
        const target = typingTargetRef.current
        if (!target) return
        flushTypingStep(target.convId, target.msgId)
      }, 12)
    },
    [flushTypingStep]
  )

  const enqueueToken = useCallback(
    (convId: string, msgId: string, token: string) => {
      if (!token) return
      tokenQueueRef.current += token
      ensureTypingLoop(convId, msgId)
    },
    [ensureTypingLoop]
  )

  const flushAllQueuedTokens = useCallback((convId: string, msgId: string) => {
    if (!tokenQueueRef.current) return
    const rest = tokenQueueRef.current
    tokenQueueRef.current = ''
    appendToStreamingMessage(convId, msgId, rest)
  }, [appendToStreamingMessage])

  const resetTokenBuffer = useCallback(() => {
    tokenQueueRef.current = ''
    typingTargetRef.current = null
    if (typingTimerRef.current) {
      clearInterval(typingTimerRef.current)
      typingTimerRef.current = null
    }
  }, [])

  // 中断请求
  const handleAbort = useCallback(() => {
    window.electronAPI.abortChat()
  }, [])

  const handleCopyMessage = useCallback(async (message: Message) => {
    try {
      await navigator.clipboard.writeText(message.content || '')
    } catch (err) {
      console.error('复制失败', err)
    }
  }, [])

  const handleEditUserMessage = useCallback(
    (messageId: string, content: string) => {
      if (!activeId) return
      setConversations((prev) => {
        const updated = prev.map((c) => {
          if (c.id !== activeId) return c
          const nextTitle =
            c.messages.find((m) => m.role === 'user')?.id === messageId
              ? generateTitle(content)
              : c.title
          return {
            ...c,
            title: nextTitle,
            messages: c.messages.map((m) =>
              m.id === messageId ? { ...m, content } : m
            ),
            updatedAt: Date.now(),
          }
        })
        const updatedConv = updated.find((c) => c.id === activeId)
        if (updatedConv) persistConversation(updatedConv)
        return updated
      })
    },
    [activeId, persistConversation]
  )

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      if (!activeId) return
      setConversations((prev) => {
        const updated = prev.map((c) => {
          if (c.id !== activeId) return c
          const nextMessages = c.messages.filter((m) => m.id !== messageId)
          const firstUser = nextMessages.find((m) => m.role === 'user')
          return {
            ...c,
            title: firstUser ? generateTitle(firstUser.content) : '新对话',
            messages: nextMessages,
            updatedAt: Date.now(),
          }
        })
        const updatedConv = updated.find((c) => c.id === activeId)
        if (updatedConv) persistConversation(updatedConv)
        return updated
      })
    },
    [activeId, persistConversation]
  )

  const handleRegenerateMessage = useCallback(
    async (messageId: string) => {
      if (isLoading || !activeId) return

      const targetConv = conversations.find((c) => c.id === activeId)
      if (!targetConv) return

      const aiIndex = targetConv.messages.findIndex(
        (m) => m.id === messageId && m.role === 'assistant'
      )
      if (aiIndex < 0) return

      let userIndex = -1
      for (let i = aiIndex - 1; i >= 0; i--) {
        if (targetConv.messages[i].role === 'user') {
          userIndex = i
          break
        }
      }
      if (userIndex < 0) return

      const userMsg = targetConv.messages[userIndex]
      const baseMessages = targetConv.messages.slice(0, userIndex + 1)
      const history = baseMessages.slice(0, -1).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      const aiMsgId = uuidv4()
      const nextAiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
      }

      resetTokenBuffer()
      streamingMsgIdRef.current = aiMsgId
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? {
                ...c,
                messages: [...baseMessages, nextAiMsg],
                updatedAt: Date.now(),
              }
            : c
        )
      )

      setIsLoading(true)

      const removeToken = window.electronAPI.onToken((token) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        enqueueToken(activeId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ toolName, input }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolCalls: [...(m.toolCalls ?? []), { toolName, input }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeToolResult = window.electronAPI.onToolResult(({ toolName, result }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolResults: [...(m.toolResults ?? []), { toolName, result }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const finalize = (errorUpdate?: Partial<Message>) => {
        flushAllQueuedTokens(activeId, aiMsgId)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === activeId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === activeId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        setIsLoading(false)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(() => finalize())
      const removeError = window.electronAPI.onError((err) =>
        finalize({ content: `错误：${err}`, isError: true })
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeDone()
        removeError()
        resetTokenBuffer()
        streamingMsgIdRef.current = null
      }

      await window.electronAPI.sendMessage(history, userMsg.content, useAgent)
    },
    [isLoading, activeId, conversations, persistConversation, useAgent, enqueueToken, flushAllQueuedTokens, resetTokenBuffer]
  )

  // 发送消息
  const handleSend = useCallback(
    async (text: string, agentMode: boolean) => {
      if (isLoading) return

      let convId = activeId
      if (!convId) {
        const conv = createConversation()
        setConversations((prev) => [conv, ...prev])
        setActiveId(conv.id)
        convId = conv.id
        window.electronAPI.storage.save(
          { id: conv.id, title: conv.title, createdAt: conv.createdAt, updatedAt: conv.updatedAt },
          []
        )
      }

      const userMsg = createMessage('user', text)
      const aiMsgId = uuidv4()
      const aiMsg: Message = {
        id: aiMsgId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        toolCalls: [],
        toolResults: [],
      }

      resetTokenBuffer()
      streamingMsgIdRef.current = aiMsgId

      const targetConv = conversations.find((c) => c.id === convId)
      const isFirstMsg = (targetConv?.messages.length ?? 0) === 0
      const newTitle = isFirstMsg ? generateTitle(text) : (targetConv?.title ?? '新对话')

      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                title: newTitle,
                messages: [...c.messages, userMsg, aiMsg],
                updatedAt: Date.now(),
              }
            : c
        )
      )

      setIsLoading(true)

      const history = (targetConv?.messages ?? []).map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }))

      const removeToken = window.electronAPI.onToken((token) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        enqueueToken(convId, aiMsgId, token)
      })

      const removeToolCall = window.electronAPI.onToolCall(({ toolName, input }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolCalls: [...(m.toolCalls ?? []), { toolName, input }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const removeToolResult = window.electronAPI.onToolResult(({ toolName, result }) => {
        if (streamingMsgIdRef.current !== aiMsgId) return
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId
                      ? { ...m, toolResults: [...(m.toolResults ?? []), { toolName, result }] }
                      : m
                  ),
                }
              : c
          )
        )
      })

      const finalize = (errorUpdate?: Partial<Message>) => {
        flushAllQueuedTokens(convId, aiMsgId)
        setConversations((prev) => {
          const updated = prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  messages: c.messages.map((m) =>
                    m.id === aiMsgId ? { ...m, isStreaming: false, ...errorUpdate } : m
                  ),
                  updatedAt: Date.now(),
                }
              : c
          )
          const updatedConv = updated.find((c) => c.id === convId)
          if (updatedConv) persistConversation(updatedConv)
          return updated
        })
        setIsLoading(false)
        cleanup()
      }

      const removeDone = window.electronAPI.onDone(() => finalize())

      const removeError = window.electronAPI.onError((err) =>
        finalize({ content: `错误：${err}`, isError: true })
      )

      const cleanup = () => {
        removeToken()
        removeToolCall()
        removeToolResult()
        removeDone()
        removeError()
        resetTokenBuffer()
        streamingMsgIdRef.current = null
      }

      await window.electronAPI.sendMessage(history, text, agentMode)
    },
    [isLoading, activeId, conversations, persistConversation, enqueueToken, flushAllQueuedTokens, resetTokenBuffer]
  )

  return (
    <div className={styles.app}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        models={models}
        currentModel={currentModel}
        onModelChange={handleModelChange}
      />
      <div className={styles.main}>
        <div className={styles.topbar}>
          <span className={styles.convTitle}>
            {activeConversation?.title ?? '新对话'}
          </span>
          <span className={styles.modelBadge}>{currentModel}</span>
        </div>

        <ChatArea
          messages={activeConversation?.messages ?? []}
          isLoading={isLoading || (activeConversation !== null && !activeConversation.loaded)}
          onCopyMessage={handleCopyMessage}
          onEditUserMessage={handleEditUserMessage}
          onDeleteMessage={handleDeleteMessage}
          onRegenerateMessage={handleRegenerateMessage}
        />

        <InputBar
          onSend={handleSend}
          onAbort={handleAbort}
          isLoading={isLoading}
          useAgent={useAgent}
          onToggleAgent={() => setUseAgent((v) => !v)}
        />
      </div>
    </div>
  )
}

export default App
