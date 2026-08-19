import { describe, expect, it } from 'vitest'
import { translator } from './i18n'

describe('language preferences', () => {
  it('provides real English and Chinese UI copy', () => {
    expect(translator('en')('heroTitle')).toContain('Create agents')
    expect(translator('zh')('heroTitle')).toContain('创建 Agent')
    expect(translator('zh')('privacyText')).toContain('NVIDIA')
    expect(translator('zh')('clearData')).not.toBe(translator('en')('clearData'))
  })
})
