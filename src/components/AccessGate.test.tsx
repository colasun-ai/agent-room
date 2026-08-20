import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AccessGate } from './AccessGate'

afterEach(() => vi.unstubAllGlobals())

describe('AccessGate', () => {
  it('renders the application when the access cookie is valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ authenticated: true })))
    render(<AccessGate><div>Private app</div></AccessGate>)
    expect(await screen.findByText('Private app')).toBeVisible()
  })

  it('keeps the password out of storage and unlocks after server verification', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ authenticated: false }))
      .mockResolvedValueOnce(Response.json({ authenticated: true, expiresAt: Date.now() + 60_000 }))
    vi.stubGlobal('fetch', request)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    render(<AccessGate><div>Private app</div></AccessGate>)
    const field = await screen.findByLabelText(/Access password/)
    fireEvent.change(field, { target: { value: 'local-test-password' } })
    fireEvent.click(screen.getByRole('button', { name: /Enter/ }))
    expect(await screen.findByText('Private app')).toBeVisible()
    expect(storage).not.toHaveBeenCalled()
    expect(request).toHaveBeenLastCalledWith('/api/access', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
    storage.mockRestore()
  })
})
