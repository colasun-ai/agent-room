import { useEffect, useRef } from 'react'

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement, options: { sitekey: string; action: string; callback: (token: string) => void; 'error-callback': () => void; 'expired-callback': () => void }) => string
      remove: (widgetId: string) => void
    }
  }
}

export function TurnstileChallenge({ siteKey, onToken, onError }: { siteKey: string; onToken: (token: string) => void; onError: () => void }) {
  const container = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let widgetId: string | undefined
    let disposed = false
    const render = () => {
      if (disposed || !container.current || !window.turnstile) return
      widgetId = window.turnstile.render(container.current, { sitekey: siteKey, action: 'agentroom-session', callback: onToken, 'error-callback': onError, 'expired-callback': onError })
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-agentroom-turnstile]')
    if (window.turnstile) render()
    else if (existing) existing.addEventListener('load', render, { once: true })
    else {
      const script = document.createElement('script')
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
      script.async = true
      script.defer = true
      script.dataset.agentroomTurnstile = 'true'
      script.addEventListener('load', render, { once: true })
      script.addEventListener('error', onError, { once: true })
      document.head.append(script)
    }
    return () => { disposed = true; existing?.removeEventListener('load', render); if (widgetId && window.turnstile) window.turnstile.remove(widgetId) }
  }, [onError, onToken, siteKey])
  return <div className="turnstile-challenge" ref={container} aria-live="polite"/>
}
