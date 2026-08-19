import type { ProviderMessage } from './prompt'

export type ProviderEvent = { type: 'content'; delta: string } | { type: 'usage'; inputTokens?: number; outputTokens?: number }

export class ProviderError extends Error {
  constructor(
    public readonly kind: 'aborted' | 'timeout' | 'auth' | 'rate' | 'transient' | 'malformed' | 'unavailable',
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly beforeVisibleToken = true,
  ) { super(kind) }
}

export interface ProviderOptions {
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens: number
  temperature?: number
  fetcher?: typeof fetch
  connectTimeoutMs?: number
  firstTokenTimeoutMs?: number
  idleTimeoutMs?: number
  totalTimeoutMs?: number
  mock?: boolean
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined
}

export async function* parseNvidiaSse(stream: ReadableStream<Uint8Array>, signal?: AbortSignal, idleTimeoutMs = 30_000): AsyncGenerator<ProviderEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const cancel = () => { void reader.cancel(signal?.reason).catch(() => undefined) }
  signal?.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      if (signal?.aborted) throw new ProviderError('aborted')
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel(); reject(new ProviderError('timeout')) }, idleTimeoutMs) }),
      ])
      if (timer) clearTimeout(timer)
      const { done, value } = result
      if (signal?.aborted) throw new ProviderError('aborted')
      buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')
        if (data && data !== '[DONE]') {
          let parsed: { choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
          try { parsed = JSON.parse(data) as typeof parsed } catch { throw new ProviderError('malformed') }
          const delta = parsed.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) yield { type: 'content', delta }
          if (parsed.usage) yield { type: 'usage', inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens }
        }
        boundary = buffer.indexOf('\n\n')
      }
      if (done) break
    }
    if (buffer.trim() && buffer.trim() !== 'data: [DONE]') throw new ProviderError('malformed')
  } finally {
    signal?.removeEventListener('abort', cancel)
    reader.releaseLock()
  }
}

function timeoutSignal(ms: number, parent: AbortSignal): { signal: AbortSignal; clear: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timeout = false
  const abort = () => controller.abort(parent.reason)
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timeout = true; controller.abort(new Error('timeout')) }, ms)
  return { signal: controller.signal, clear: () => { clearTimeout(timer); parent.removeEventListener('abort', abort) }, timedOut: () => timeout }
}

export class NvidiaProvider {
  constructor(private readonly options: ProviderOptions) {}

  async *streamChat(messages: ProviderMessage[], signal: AbortSignal): AsyncGenerator<ProviderEvent> {
    if (this.options.mock) {
      if (signal.aborted) throw new ProviderError('aborted')
      yield { type: 'content', delta: 'Mock response.' }
      return
    }
    const fetcher = this.options.fetcher ?? fetch
    const total = timeoutSignal(this.options.totalTimeoutMs ?? 90_000, signal)
    const connect = timeoutSignal(this.options.connectTimeoutMs ?? 10_000, total.signal)
    let response: Response
    try {
      response = await fetcher(`${this.options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ model: this.options.model, messages, stream: true, max_tokens: this.options.maxOutputTokens, temperature: Math.max(0, Math.min(1.5, this.options.temperature ?? 0.7)) }),
        signal: connect.signal,
      })
    } catch {
      connect.clear(); total.clear()
      if (signal.aborted) throw new ProviderError('aborted')
      if (connect.timedOut() || total.timedOut()) throw new ProviderError('timeout')
      throw new ProviderError('transient')
    }
    connect.clear()
    if (!response.ok) {
      total.clear()
      if (response.status === 401 || response.status === 403) throw new ProviderError('auth', response.status)
      if (response.status === 429) throw new ProviderError('rate', 429, parseRetryAfter(response.headers.get('retry-after')))
      if (response.status >= 500) throw new ProviderError('transient', response.status)
      throw new ProviderError('unavailable', response.status)
    }
    if (!response.body) { total.clear(); throw new ProviderError('malformed') }
    let visible = false
    const firstToken = timeoutSignal(this.options.firstTokenTimeoutMs ?? 20_000, total.signal)
    try {
      for await (const event of parseNvidiaSse(response.body, firstToken.signal, this.options.idleTimeoutMs ?? 30_000)) {
        if (event.type === 'content') { visible = true; firstToken.clear() }
        yield event
      }
    } catch (error) {
      if (signal.aborted) throw new ProviderError('aborted', undefined, undefined, !visible)
      if (firstToken.timedOut() || total.timedOut()) throw new ProviderError('timeout', undefined, undefined, !visible)
      if (error instanceof ProviderError) throw new ProviderError(error.kind, error.status, error.retryAfterMs, !visible)
      throw new ProviderError('transient', undefined, undefined, !visible)
    } finally {
      firstToken.clear(); total.clear()
    }
  }
}
