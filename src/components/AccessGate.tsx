import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AgentRoomApiError, api } from '../api'

export function AccessGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'locked' | 'granted'>('checking')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let current = true
    void api.accessStatus()
      .then((result) => { if (current) setState(result.authenticated ? 'granted' : 'locked') })
      .catch(() => { if (current) setState('locked') })
    return () => { current = false }
  }, [])

  useEffect(() => { if (state === 'locked') input.current?.focus() }, [state])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true); setError(undefined)
    try {
      await api.unlock(password)
      setPassword('')
      setState('granted')
    } catch (caught) {
      const limited = caught instanceof AgentRoomApiError && caught.code === 'RATE_LIMITED'
      setError(limited ? '尝试次数过多，请稍后再试。 / Too many attempts. Try again later.' : '密码不正确，请重试。 / Incorrect password. Try again.')
      setPassword('')
      input.current?.focus()
    } finally { setSubmitting(false) }
  }

  if (state === 'granted') return children
  if (state === 'checking') return <main className="access-shell"><span className="loader" aria-label="Checking access"/></main>
  return <main className="access-shell">
    <section className="access-card" aria-labelledby="access-title">
      <div className="access-brand"><span className="brand-glyph">A</span><strong>AgentRoom</strong><small>PRIVATE BETA</small></div>
      <p className="eyebrow">Authorized developers only · 仅限授权开发者</p>
      <h1 id="access-title">Enter the room.<br/><span>进入测试空间。</span></h1>
      <p className="access-copy">This private beta requires an access password. The password is verified securely and is never stored in this browser.</p>
      <p className="access-copy">此开发测试版需要访问密码。密码仅用于安全验证，不会保存在浏览器中。</p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="access-password">Access password · 访问密码</label>
        <div className="access-input-row">
          <input ref={input} id="access-password" name="password" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} aria-describedby={error ? 'access-error' : undefined}/>
          <button className="button primary" disabled={!password || submitting}>{submitting ? 'Verifying…' : 'Enter →'}</button>
        </div>
        {error && <p id="access-error" className="access-error" role="alert">{error}</p>}
      </form>
      <p className="access-footnote">Access expires after 24 hours · 访问授权将在 24 小时后失效</p>
    </section>
  </main>
}
