import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { translator } from '../i18n'
import type { LocalAgent } from '../model'
import { AgentEditor } from './AgentEditor'
import { MarkdownMessage } from './MarkdownMessage'

const agent: LocalAgent = { id: 'maya', roomId: 'room', name: 'Maya', normalizedName: 'maya', role: 'Engineer', avatar: '⚙️', personality: 'Precise', goal: 'Ship safely', enabled: true, temperature: 0.7 }

describe('agent editor', () => {
  it('keeps advanced customization additive and exposes no system override', () => {
    render(<AgentEditor agent={agent} index={0} canRemove t={translator('en')} onChange={() => undefined} onRemove={() => undefined}/>)
    fireEvent.click(screen.getByText('Advanced'))
    expect(screen.getByText('Custom instructions')).toBeInTheDocument()
    expect(screen.queryByText(/system prompt/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/model/i)).not.toBeInTheDocument()
  })
})

describe('safe markdown', () => {
  it('does not render raw HTML and highlights exact room mentions', () => {
    const { container } = render(<MarkdownMessage content={'Hello **@Maya** <script>alert(1)</script> and @Unknown ![tracker](https://example.com/pixel.gif)'} agents={[agent]}/>)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('mark')).toHaveTextContent('@Maya')
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('adds safe external-link attributes', () => {
    render(<MarkdownMessage content={'[site](https://example.com)'} agents={[agent]}/>)
    expect(screen.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer')
    expect(screen.getByRole('link')).toHaveAttribute('target', '_blank')
  })

  it('copies code without executing it', () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } })
    render(<MarkdownMessage content={'```js\nconsole.log("safe")\n```'} agents={[agent]}/>)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('console.log("safe")')
  })
})
