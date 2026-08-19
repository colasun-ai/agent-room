import { describe, expect, it } from 'vitest'
import { normalizeNetworkRiskSource } from './security'

describe('network risk source normalization', () => {
  it('groups IPv6 address rotation within one /64', () => {
    expect(normalizeNetworkRiskSource('2001:db8:abcd:12::1')).toBe('ipv6:2001:db8:abcd:12::/64')
    expect(normalizeNetworkRiskSource('2001:0db8:abcd:0012:ffff::99')).toBe('ipv6:2001:db8:abcd:12::/64')
  })

  it('preserves valid IPv4 and rejects malformed input', () => {
    expect(normalizeNetworkRiskSource('192.0.2.7')).toBe('ipv4:192.0.2.7')
    expect(normalizeNetworkRiskSource('999.0.2.7')).toBe('network:unknown')
  })
})
