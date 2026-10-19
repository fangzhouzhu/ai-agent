import { AsyncLocalStorage } from 'node:async_hooks'

const toolSignal = new AsyncLocalStorage<AbortSignal>()

export function withToolSignal<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  return toolSignal.run(signal, work)
}

// Search helpers and their fallback fetches inherit the invoking tool's signal,
// while preserving shorter per-request deadlines.
export function fetchWithToolSignal(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const signal = toolSignal.getStore()
  signal?.throwIfAborted()
  return fetch(input, {
    ...init,
    signal: signal && init.signal ? AbortSignal.any([signal, init.signal]) : signal ?? init.signal,
  })
}
