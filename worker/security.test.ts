import { describe, expect, it } from 'vitest'
import { hmac, issueAccess, normalizeNetworkRiskSource, readAccess, secretsEqual, trustedRequest } from './security'
import type { Env } from './types'

describe('network risk source normalization', () => {
  it('compares access passwords and accepts only signed, unexpired access cookies', async () => {
    const secret = 'access-secret-at-least-long'
    expect(await secretsEqual('developer-password', 'developer-password')).toBe(true)
    expect(await secretsEqual('developer-password', 'different-password')).toBe(false)
    const active = await issueAccess(Date.now() + 60_000, secret)
    expect(await readAccess(new Request('https://app.test', { headers: { cookie: `__Host-ar_access=${active}` } }), secret)).toBe(true)
    expect(await readAccess(new Request('https://app.test', { headers: { cookie: `__Host-ar_access=${active}x` } }), secret)).toBe(false)
    const expired = await issueAccess(Date.now() - 1, secret)
    expect(await readAccess(new Request('https://app.test', { headers: { cookie: `__Host-ar_access=${expired}` } }), secret)).toBe(false)
  })

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
