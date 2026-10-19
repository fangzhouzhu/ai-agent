export async function runWithSignal<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => controller.abort(new Error(`${options.label ?? '操作'} 超时（${options.timeoutMs! / 1000}s）`)), options.timeoutMs)
    }
    return await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return work(controller.signal)
    }), aborted])
  } finally {
    if (timer) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
