import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'
import type { ToolApprovalRequest } from './ToolExecutor'
import { runWithSignal } from './async'

type Pending = { ownerId: number; conversationId: string; resolve: (approved: boolean) => void }
const pending = new Map<string, Pending>()
let queue: Promise<unknown> = Promise.resolve()

// One visible confirmation at a time, including requests from concurrent tasks.
export function requestApproval(request: ToolApprovalRequest, options: {
  webContents: WebContents
  conversationId: string
  signal?: AbortSignal
}): Promise<boolean> {
  const operation = queue.catch(() => undefined).then(() => runWithSignal(async signal => {
    signal.throwIfAborted()
    if (options.webContents.isDestroyed()) throw new Error('确认窗口已关闭')
    const requestId = randomUUID()
    let finish: (approved: boolean) => void = () => {}
    const result = new Promise<boolean>(resolve => { finish = resolve })
    const cancel = () => finish(false)
    pending.set(requestId, { ownerId: options.webContents.id, conversationId: options.conversationId, resolve: finish })
    signal.addEventListener('abort', cancel, { once: true })
    options.webContents.once('destroyed', cancel)
    try {
      options.webContents.send('chat:tool-approval-request', {
        requestId, conversationId: options.conversationId, toolName: request.toolName, input: request.args, policy: request.policy, preview: request.preview,
      })
      return await result
    } finally {
      pending.delete(requestId)
      if (!options.webContents.isDestroyed()) options.webContents.send('chat:tool-approval-cancelled', requestId)
      signal.removeEventListener('abort', cancel)
      options.webContents.removeListener('destroyed', cancel)
    }
  }, { signal: options.signal, timeoutMs: 300_000, label: '等待工具确认' }))
  queue = operation
  return operation
}

export function resolveApproval(requestId: string, approved: boolean, ownerId: number): boolean {
  const item = pending.get(requestId)
  if (!item || item.ownerId !== ownerId) return false
  pending.delete(requestId)
  item.resolve(approved)
  return true
}

export function resolveConversationApprovals(conversationId: string, approved: boolean): void {
  for (const [id, item] of pending) {
    if (item.conversationId !== conversationId) continue
    pending.delete(id)
    item.resolve(approved)
  }
}
