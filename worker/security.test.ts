import { describe, expect, it } from 'vitest'
import { hmac, normalizeNetworkRiskSource, trustedRequest } from './security'
import type { Env } from './types'

describe('network risk source normalization', () => {
  it('groups IPv6 address rotation within one /64', () => {
    expect(normalizeNetworkRiskSource('2001:db8:abcd:12::1')).toBe('ipv6:2001:db8:abcd:12::/64')
    expect(normalizeNetworkRiskSource('2001:0db8:abcd:0012:ffff::99')).toBe('ipv6:2001:db8:abcd:12::/64')
  })

  it('preserves valid IPv4 and rejects malformed input', () => {
    expect(normalizeNetworkRiskSource('192.0.2.7')).toBe('ipv4:192.0.2.7')
    expect(normalizeNetworkRiskSource('999.0.2.7')).toBe('network:unknown')
  })

  it('accepts only a fresh path-bound smoke signature when Origin is absent', async () => {
    const timestamp = String(Date.now()), secret = 'smoke-secret-at-least-long'
    const signature = await hmac(secret, `POST\n/api/rooms/room-0001/turn\n${timestamp}`)
    const env = { PUBLIC_ORIGIN: 'https://app.test', SMOKE_TEST_SECRET: secret } as Env
    const signed = new Request('https://app.test/api/rooms/room-0001/turn', { method: 'POST', headers: { 'x-agentroom-smoke-timestamp': timestamp, 'x-agentroom-smoke-signature': signature } })
    expect(await trustedRequest(signed, env)).toBe(true)
    expect(await trustedRequest(new Request('https://app.test/api/rooms/other-room/turn', { method: 'POST', headers: signed.headers }), env)).toBe(false)
    const stale = String(Date.now() - 6 * 60_000)
    expect(await trustedRequest(new Request('https://app.test/api/rooms/room-0001/turn', { method: 'POST', headers: { 'x-agentroom-smoke-timestamp': stale, 'x-agentroom-smoke-signature': await hmac(secret, `POST\n/api/rooms/room-0001/turn\n${stale}`) } }), env)).toBe(false)
  })
})
