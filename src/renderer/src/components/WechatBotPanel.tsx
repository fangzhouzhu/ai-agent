import React, { useEffect, useMemo, useRef, useState } from 'react'
import type {
  OpenClawGatewayState,
  WechatBotMessage,
  WechatBotStatus,
} from '../../../preload/index'
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

function shouldShowGatewayRestart(
  status: WechatBotStatus | null,
  gatewayState: OpenClawGatewayState | null
): boolean {
  if (!gatewayState) return false
  if (gatewayState.installing) return false
  if (gatewayState.lastError) return true

  return status?.status === 'bound' && gatewayState.running === false
}

function isGatewaySystemMessage(message: WechatBotMessage): boolean {
  return (
    message.role === 'system' &&
    message.source === 'system' &&
    /openclaw gateway|gateway did not become healthy|gateway exited/i.test(message.text)
  )
}

const WechatBotPanel: React.FC<Props> = ({ onOpenSettings }) => {
  const [status, setStatus] = useState<WechatBotStatus | null>(null)
  const [messages, setMessages] = useState<WechatBotMessage[]>([])
  const [gatewayState, setGatewayState] = useState<OpenClawGatewayState | null>(null)
  const [isRestartingGateway, setIsRestartingGateway] = useState(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false

    const load = async () => {
      const [nextStatus, nextMessages, nextGatewayState] = await Promise.all([
        window.electronAPI.getWechatBotStatus(),
        window.electronAPI.listWechatBotMessages(),
        window.electronAPI.getOpenClawGatewayState(),
      ])

      if (disposed) return
      setStatus(nextStatus)
      setMessages(nextMessages)
      setGatewayState(nextGatewayState)
    }

    void load()

    const timer = window.setInterval(() => {
      void window.electronAPI
        .getOpenClawGatewayState()
        .then((nextGatewayState) => {
          if (!disposed) {
            setGatewayState(nextGatewayState)
          }
        })
        .catch(() => {})
    }, 5000)

    const remove = window.electronAPI.onWechatBotUpdate((data) => {
      setStatus(data.status)
      setMessages(data.messages)
    })

    return () => {
      disposed = true
      window.clearInterval(timer)
      remove()
    }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const isBound = status?.status === 'bound'
  const showRestartGateway = shouldShowGatewayRestart(status, gatewayState)
  const gatewayErrorText = gatewayState?.lastError || 'OpenClaw gateway 当前未正常运行。'
  const displayMessages = useMemo(
    () => messages.filter((message) => !isGatewaySystemMessage(message)),
    [messages]
  )
  const renderedMessages = useMemo(
    () =>
      displayMessages.map((message) => ({
        raw: message,
        chat: toChatMessage(message),
      })),
    [displayMessages]
  )

  const gatewayStatus = useMemo(() => {
    if (!gatewayState) {
      return {
        tone: 'neutral' as const,
        title: '网关状态未知',
        text: '正在读取 OpenClaw gateway 状态。',
      }
    }

    if (gatewayState.installing) {
      return {
        tone: 'warn' as const,
        title: '网关环境安装中',
        text: 'OpenClaw 运行时正在准备，请稍候。',
      }
    }

    if (gatewayState.lastError) {
      return {
        tone: 'error' as const,
        title: '网关异常',
        text: gatewayErrorText,
      }
    }

    if (gatewayState.running) {
      return {
        tone: 'ok' as const,
        title: '网关运行中',
        text: gatewayState.runtimeReady
          ? 'OpenClaw gateway 已正常运行，可接收微信消息转发。'
          : 'OpenClaw gateway 已启动，运行时仍在准备。',
      }
    }

    return {
      tone: 'warn' as const,
      title: isBound ? '网关未运行' : '等待绑定后启动网关',
      text: isBound
        ? '微信已绑定，但 OpenClaw gateway 当前未运行。'
        : '完成微信 ClawBot 绑定后会自动启动 OpenClaw gateway。',
    }
  }, [gatewayErrorText, gatewayState, isBound])

  const lastUserIdx = useMemo(
    () => renderedMessages.reduce((acc, item, index) => (item.chat?.role === 'user' ? index : acc), -1),
    [renderedMessages]
  )
  const lastAiIdx = useMemo(
    () => renderedMessages.reduce((acc, item, index) => (item.chat?.role === 'assistant' ? index : acc), -1),
    [renderedMessages]
  )

  return (
    <div className={styles.container}>
      <header className={styles.topbar}>
        <div className={styles.headerMain}>
          <div className={styles.headerInfo}>
            <h2>微信 ClawBot</h2>
          </div>
          <div className={styles.headerActions}>
            <div
              className={`${styles.gatewayInline} ${
                gatewayStatus.tone === 'ok'
                  ? styles.gatewayInlineOk
                  : gatewayStatus.tone === 'error'
                    ? styles.gatewayInlineError
                    : gatewayStatus.tone === 'warn'
                      ? styles.gatewayInlineWarn
                      : styles.gatewayInlineNeutral
              }`}
              title={gatewayStatus.text}
            >
              <div className={styles.gatewayInlineMain}>
                <span className={styles.gatewayInlineLabel}>网关</span>
                <span className={styles.gatewayInlineTitle}>{gatewayStatus.title}</span>
                <span className={styles.gatewayInlineText}>{gatewayStatus.text}</span>
              </div>
              {showRestartGateway && (
                <button
                  className={`${styles.sendBtn} ${styles.restartBtn} ${styles.gatewayInlineBtn}`}
                  disabled={isRestartingGateway}
                  onClick={async () => {
                    try {
                      setIsRestartingGateway(true)
                      const nextGatewayState = await window.electronAPI.restartOpenClawGateway()
                      setGatewayState(nextGatewayState)
                    } catch (error) {
                      setGatewayState((current) => ({
                        running: false,
                        installing: current?.installing ?? false,
                        runtimeReady: current?.runtimeReady ?? false,
                        logs: current?.logs ?? [],
                        lastError: error instanceof Error ? error.message : '重启 OpenClaw gateway 失败',
                      }))
                    } finally {
                      setIsRestartingGateway(false)
                    }
                  }}
                >
                  {isRestartingGateway ? '重启中...' : '重启'}
                </button>
              )}
            </div>
            <span className={`${styles.badge} ${isBound ? styles.badgeOn : ''}`}>
              {status ? statusLabel[status.status] : '加载中'}
            </span>
            <button className={styles.settingsBtn} onClick={onOpenSettings}>
              绑定设置
            </button>
          </div>
        </div>
        <p className={styles.headerDesc}>
          这里会同步展示微信 ClawBot 的消息，以及 Centibot 按同一套聊天界面呈现的处理结果。
        </p>
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
