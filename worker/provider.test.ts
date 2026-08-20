import { describe, expect, it, vi } from 'vitest'
import { NvidiaProvider, ProviderError, parseNvidiaSse } from './provider'

function sse(parts: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close() } })
}

describe('NVIDIA SSE adapter', () => {
  it('parses split frames and turns hidden reasoning into content-free progress', async () => {
    const stream = sse(['data: {"choices":[{"delta":{"reasoning_content":"secret","content":"hel', 'lo"}}]}\n\ndata: [DONE]\n\n'])
    const events = []
    for await (const event of parseNvidiaSse(stream)) events.push(event)
    expect(events).toEqual([{ type: 'progress' }, { type: 'content', delta: 'hello' }])
    expect(JSON.stringify(events)).not.toContain('secret')
  })

  it('uses hidden reasoning progress to satisfy the upstream first-event timeout', async () => {
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}\n\n'))
        setTimeout(() => {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"visible"}}]}\n\ndata: [DONE]\n\n'))
          controller.close()
        }, 30)
      },
    })
    const provider = new NvidiaProvider({ baseUrl: 'https://nvidia.test/v1', apiKey: 'secret', model: 'one-model', maxOutputTokens: 50, fetcher: async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }), firstTokenTimeoutMs: 10, idleTimeoutMs: 100, totalTimeoutMs: 200 })
    const events = []
    for await (const event of provider.streamChat([], new AbortController().signal)) events.push(event)
    expect(events).toEqual([{ type: 'progress' }, { type: 'content', delta: 'visible' }])
  })

  it('normalizes 429 and retry-after without exposing upstream bodies', async () => {
    const fetcher = vi.fn(async () => new Response('secret body', { status: 429, headers: { 'retry-after': '7' } }))
    const provider = new NvidiaProvider({ baseUrl: 'https://nvidia.test/v1', apiKey: 'secret', model: 'one-model', maxOutputTokens: 50, fetcher })
    const consume = async () => { for await (const event of provider.streamChat([], new AbortController().signal)) void event }
    await expect(consume()).rejects.toMatchObject({ kind: 'rate', retryAfterMs: 7000 } satisfies Partial<ProviderError>)
  })

  it('passes the abort signal to upstream fetch', async () => {
    let observed: AbortSignal | undefined
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { observed = init?.signal ?? undefined; throw new DOMException('aborted', 'AbortError') })
    const provider = new NvidiaProvider({ baseUrl: 'https://nvidia.test/v1', apiKey: 'secret', model: 'one-model', maxOutputTokens: 50, fetcher })
    const controller = new AbortController(); controller.abort()
    const consume = async () => { for await (const event of provider.streamChat([], controller.signal)) void event }
    await expect(consume()).rejects.toMatchObject({ kind: 'aborted' })
    expect(observed).toBeInstanceOf(AbortSignal)
    expect(observed?.aborted).toBe(true)
  })
})
