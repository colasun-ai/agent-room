import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { normalizeAgentName, TURN_LIMITS, type TurnLimit } from '../shared/protocol'
import { AgentRoomApiError, api } from './api'
import { AgentEditor, blankAgent } from './components/AgentEditor'
import { MarkdownMessage } from './components/MarkdownMessage'
import { TurnstileChallenge } from './components/TurnstileChallenge'
import { clearAllLocalData, deleteRoomCascade, listRooms, putRoom, putRun, recoverInterruptedMessages, saveNewRoom } from './db'
import { translator } from './i18n'
import type { Language, LocalAgent, LocalMessage, LocalRoom, LocalRun, ThemePreference } from './model'
import { ROOM_TEMPLATES, instantiateTemplate, type TemplateId } from './templates'
import { useRoomController } from './useRoomController'

function navigate(path: string) { history.pushState({}, '', path); window.dispatchEvent(new PopStateEvent('popstate')) }

function usePath() {
  const [path, setPath] = useState(location.pathname + location.search)
  useEffect(() => { const update = () => setPath(location.pathname + location.search); addEventListener('popstate', update); return () => removeEventListener('popstate', update) }, [])
  return path
}

function AppLink({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) {
  return <a href={to} className={className} onClick={(event) => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); navigate(to) } }}>{children}</a>
}

function Header({ t }: { t: ReturnType<typeof translator> }) {
  return <header className="site-header">
    <AppLink to="/" className="brand"><span className="brand-glyph">A</span><span>AgentRoom</span><small>{t('beta')}</small></AppLink>
    <nav aria-label="Primary"><AppLink to="/">{t('navHome')}</AppLink><AppLink to="/new">{t('navNew')}</AppLink><AppLink to="/settings">{t('navSettings')}</AppLink><AppLink to="/about">{t('navAbout')}</AppLink></nav>
  </header>
}

function Landing({ t }: { t: ReturnType<typeof translator> }) {
  const [rooms, setRooms] = useState<LocalRoom[]>([])
  useEffect(() => { void listRooms().then(setRooms) }, [])
  return <main>
    <section className="hero">
      <div className="hero-orbit" aria-hidden="true"><span>🧭</span><span>⚙️</span><span>◈</span></div>
      <p className="eyebrow">{t('heroEyebrow')}</p><h1>{t('heroTitle')}</h1><p className="hero-copy">{t('heroBody')}</p>
      <AppLink to="/new" className="button primary large">{t('startRoom')} <span aria-hidden="true">→</span></AppLink>
    </section>
    <section className="section-wrap"><div className="section-title"><h2>{t('templates')}</h2><span>01—03</span></div>
      <div className="template-grid">{ROOM_TEMPLATES.map((template) => { const titleKey = template.id === 'startup' ? 'startupTitle' : template.id === 'debate' ? 'debateTitle' : 'buildTitle'; const descKey = template.id === 'startup' ? 'startupDesc' : template.id === 'debate' ? 'debateDesc' : 'buildDesc'; return <AppLink key={template.id} to={`/new?template=${template.id}`} className="template-card"><span className="template-icon">{template.icon}</span><h3>{t(titleKey)}</h3><p>{t(descKey)}</p><span className="card-arrow">↗</span></AppLink> })}</div>
    </section>
    <section className="section-wrap recent"><div className="section-title"><h2>{t('recentRooms')}</h2><span>{rooms.length.toString().padStart(2, '0')}</span></div>
      {!rooms.length ? <p className="empty-note">{t('noRooms')}</p> : <div className="room-list">{rooms.slice(0, 6).map((room) => <AppLink key={room.id} to={`/room/${room.id}`} className="room-row"><span><strong>{room.title}</strong><small>{room.topic}</small></span><span className={`status ${room.status}`}>{t(room.status)}</span><span>→</span></AppLink>)}</div>}
    </section>
  </main>
}

function NewRoom({ t }: { t: ReturnType<typeof translator> }) {
  const params = new URLSearchParams(location.search)
  const templateId = (params.get('template') ?? 'startup') as TemplateId
  const template = ROOM_TEMPLATES.find((item) => item.id === templateId) ?? ROOM_TEMPLATES[0]
  const [roomId] = useState(() => crypto.randomUUID())
  const [runId] = useState(() => crypto.randomUUID())
  const [title, setTitle] = useState(template.title)
  const [topic, setTopic] = useState(template.topic)
  const [turnLimit, setTurnLimit] = useState<TurnLimit>(template.turnLimit)
  const [agents, setAgents] = useState(() => instantiateTemplate(template.id, roomId))
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const [error, setError] = useState<string>()
  const [challengeSiteKey, setChallengeSiteKey] = useState<string>()
  const enabled = agents.filter((agent) => agent.enabled)
  const uniqueNames = new Set(enabled.map((agent) => normalizeAgentName(agent.name))).size === enabled.length && enabled.every((agent) => agent.name.trim())
  const valid = title.trim() && topic.trim() && enabled.length >= 2 && enabled.length <= 6 && uniqueNames && agents.every((agent) => agent.role.trim() && agent.personality.trim() && agent.goal.trim())
  const updateAgent = (index: number, next: LocalAgent) => setAgents((current) => current.map((agent, itemIndex) => itemIndex === index ? next : agent))
  const startRoom = useCallback(async (challengeToken?: string) => {
    if (!valid || submittingRef.current) return
    submittingRef.current = true
    setSubmitting(true); setError(undefined)
    const now = Date.now()
    const draft: LocalRoom = { id: roomId, title: title.trim(), topic: topic.trim(), status: 'draft', totalTurnsCompleted: 0, activeRunId: runId, createdAt: now, updatedAt: now, schemaRevision: 1 }
    const pausedRun: LocalRun = { id: runId, roomId, turnLimit, turnsCompleted: 0, status: 'paused', createdAt: now }
    try {
      await saveNewRoom(draft, pausedRun, agents)
      await api.session(challengeToken)
      const registered = await api.register({ roomId, runId, turnLimit, runTurnsCompleted: 0, totalTurnsCompleted: 0, status: 'running', protocolTag: 'agentroom.v1', roster: agents.map((agent) => ({ agentId: agent.id, nameKey: agent.normalizedName, enabled: agent.enabled })) })
      const room: LocalRoom = { ...draft, status: 'running', controlRevision: registered.controlRevision, updatedAt: Date.now() }
      const run: LocalRun = { ...pausedRun, status: 'running' }
      await Promise.all([putRoom(room), putRun(run)])
      localStorage.setItem('agentroom:lastRoomId', roomId)
      navigate(`/room/${roomId}`)
    } catch (caught) {
      if (caught instanceof AgentRoomApiError && caught.code === 'CHALLENGE_REQUIRED') {
        const config = await api.config().catch(() => undefined)
        setChallengeSiteKey(config?.turnstileSiteKey)
        setError(config?.turnstileSiteKey ? undefined : 'Verification is required but unavailable. Please try again later.')
      } else setError(caught instanceof AgentRoomApiError ? `${caught.code}: ${caught.message}` : 'Could not start this room. Your draft remains on this device.')
      submittingRef.current = false
      setSubmitting(false)
    }
  }, [agents, roomId, runId, title, topic, turnLimit, valid])
  const submit = (event: FormEvent) => { event.preventDefault(); void startRoom() }
  return <main className="form-page"><AppLink to="/" className="back-link">← {t('back')}</AppLink><div className="page-intro"><p className="eyebrow">{t('roomSetup')}</p><h1>{t('newRoom')}</h1></div>
    <form onSubmit={(event) => void submit(event)}>
      <section className="form-section"><div className="field-grid"><label><span>{t('roomTitle')}</span><input autoFocus required maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)}/></label><label className="wide"><span>{t('topic')}</span><textarea required maxLength={4000} rows={4} value={topic} onChange={(event) => setTopic(event.target.value)}/></label></div></section>
      <section className="form-section"><div className="form-section-head"><div><h2>{t('agents')}</h2><p>{t('agentRule')}</p></div><button type="button" className="button secondary" disabled={agents.length >= 6} onClick={() => setAgents((current) => [...current, blankAgent(roomId)])}>+ {t('addAgent')}</button></div>
        <div className="agent-editor-list">{agents.map((agent, index) => <AgentEditor key={agent.id} agent={agent} index={index} canRemove={agents.length > 2} t={t} onChange={(next) => updateAgent(index, next)} onRemove={() => setAgents((current) => current.filter((item) => item.id !== agent.id))}/>)}</div>
      </section>
      <section className="form-section run-select"><h2>{t('runLength')}</h2><div className="segmented">{TURN_LIMITS.map((limit) => <button type="button" key={limit} className={turnLimit === limit ? 'selected' : ''} aria-pressed={turnLimit === limit} onClick={() => setTurnLimit(limit)}><strong>{limit}</strong><span>{t('turns')}</span></button>)}</div></section>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {challengeSiteKey && <div className="challenge-banner"><p>{t('challenge')}</p><TurnstileChallenge siteKey={challengeSiteKey} onToken={(token) => { setChallengeSiteKey(undefined); void startRoom(token) }} onError={() => setError('Verification could not load. Please retry.')}/></div>}
      <div className="form-actions"><p>{enabled.length}/6 {t('agents')}</p><button className="button primary large" disabled={!valid || submitting}>{submitting ? t('creating') : t('createStart')} <span>→</span></button></div>
    </form>
  </main>
}

function MessageRow({ message, agents, t, onRetry, onSkip, onKeep }: { message: LocalMessage; agents: LocalAgent[]; t: ReturnType<typeof translator>; onRetry: () => void; onSkip: () => void; onKeep: () => void }) {
  const agent = agents.find((item) => item.id === message.senderId)
  const failed = message.status === 'error' || message.status === 'interrupted' || message.status === 'stopped'
  return <article className={`message ${message.senderType} ${failed ? 'failed' : ''}`} data-status={message.status}>
    <div className="message-avatar" aria-hidden="true">{message.senderType === 'user' ? 'You' : (agent?.avatar ?? '·')}</div>
    <div className="message-main"><header><strong>{message.senderType === 'user' ? 'You' : message.senderName}</strong>{message.senderRole && <span>{message.senderRole}</span>}<time>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></header>
      {message.status === 'waiting' && <p className="state-line" role="status" aria-live="polite"><span className="pulse-dot"/> {message.senderName} {t('waiting')}</p>}
      {message.status === 'thinking' && <p className="state-line" role="status" aria-live="polite"><span className="thinking-dots">•••</span> {message.senderName} {t('thinking')}</p>}
      {message.content && <div className="markdown"><MarkdownMessage content={message.content} agents={agents}/>{message.status === 'streaming' && <span className="cursor"/>}</div>}
      {failed && <div className="message-failure"><p>{message.status === 'interrupted' ? t('interrupted') : message.status === 'stopped' ? t('stopped') : `${message.senderName} ${t('failed')}`} {message.errorCode && <code>{message.errorCode}</code>}</p><div>{message.content && message.status === 'interrupted' && <button type="button" onClick={onKeep}>{t('keepPartial')}</button>}<button type="button" onClick={onRetry}>{t('retry')}</button><button type="button" onClick={onSkip}>{t('skip')}</button></div></div>}
    </div>
  </article>
}

function RoomNotice({ code, t }: { code: string; t: ReturnType<typeof translator> }) {
  const capacity = ['RATE_LIMITED', 'CAPACITY_EXHAUSTED', 'QUEUE_TIMEOUT', 'UPSTREAM_RATE_LIMITED'].includes(code)
  const service = ['SERVICE_DISABLED', 'UPSTREAM_AUTH_ERROR', 'MODEL_UNAVAILABLE'].includes(code)
  const message = code === 'DAILY_CAPACITY_EXHAUSTED' ? t('dailyLimitNotice')
    : capacity ? t('rateLimitedNotice')
      : service ? t('serviceDisabledNotice')
        : code === 'PROTOCOL_MISMATCH' ? t('protocolNotice')
          : code === 'ROOM_BUSY' ? t('roomBusyNotice')
            : code === 'INVALID_REQUEST' ? t('invalidNotice')
              : code === 'CHALLENGE_UNAVAILABLE' ? t('challengeUnavailable') : t('serviceErrorNotice')
  const guidance = code === 'DAILY_CAPACITY_EXHAUSTED' || service
  return <div className="error-banner room-notice" role="alert"><span>{message}</span>
    {code === 'PROTOCOL_MISMATCH' && <button type="button" onClick={() => location.reload()}>{t('reload')}</button>}
    {guidance && <span className="notice-actions">{t('capacityLinks')} <a href="https://github.com/colasun-ai/agent-room" target="_blank" rel="noopener noreferrer">{t('source')}</a><a href="https://github.com/colasun-ai/agent-room#self-deploy" target="_blank" rel="noopener noreferrer">{t('deployOwn')}</a></span>}
  </div>
}

function RoomPage({ roomId, t }: { roomId: string; t: ReturnType<typeof translator> }) {
  const controller = useRoomController(roomId)
  const [composer, setComposer] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draftAgents, setDraftAgents] = useState<LocalAgent[]>([])
  const [nearBottom, setNearBottom] = useState(true)
  const [mobile, setMobile] = useState(() => matchMedia('(max-width: 760px)').matches)
  const scroll = useRef<HTMLDivElement>(null)
  const modal = useRef<HTMLElement>(null)
  const drawerButton = useRef<HTMLButtonElement>(null)
  const editButton = useRef<HTMLButtonElement>(null)
  const railElement = useRef<HTMLElement>(null)
  const lastCount = controller.bundle?.messages.length ?? 0
  const lastContent = controller.bundle?.messages.at(-1)?.content
  useEffect(() => { if (nearBottom) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'auto' }) }, [lastCount, nearBottom, lastContent])
  useEffect(() => { const query = matchMedia('(max-width: 760px)'); const update = () => setMobile(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update) }, [])
  useEffect(() => {
    if (!editing) return
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : editButton.current ?? undefined
    const element = modal.current
    const focusable = () => [...(element?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), summary, [href]') ?? [])]
    window.setTimeout(() => focusable()[0]?.focus(), 0)
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setEditing(false); return }
      if (event.key !== 'Tab') return
      const items = focusable(); if (!items.length) return
      const first = items[0], last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => { document.removeEventListener('keydown', keydown); previous?.focus() }
  }, [editing])
  useEffect(() => {
    if (!drawer) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : drawerButton.current ?? undefined
    const focusable = () => [...(railElement.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled])') ?? [])]
    window.setTimeout(() => focusable()[0]?.focus(), 0)
    const closeDrawer = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setDrawer(false); return }
      if (event.key !== 'Tab') return
      const items = focusable(); if (!items.length) return
      const first = items[0], last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', closeDrawer)
    return () => { document.removeEventListener('keydown', closeDrawer); previous?.focus() }
  }, [drawer])
  if (controller.loading) return <main className="center-state"><span className="loader" aria-label="Loading"/></main>
  if (!controller.bundle) return <main className="center-state"><h1>{t('notFound')}</h1><AppLink className="button primary" to="/">{t('home')}</AppLink></main>
  const { room, agents, messages, runs } = controller.bundle
  const run = runs.find((item) => item.id === room.activeRunId)
  const streaming = messages.some((message) => ['pending', 'waiting', 'thinking', 'streaming'].includes(message.status))
  const enabled = draftAgents.filter((agent) => agent.enabled)
  const editorValid = enabled.length >= 2 && enabled.length <= 6 && new Set(enabled.map((agent) => agent.normalizedName)).size === enabled.length && draftAgents.every((agent) => agent.name.trim() && agent.role.trim() && agent.personality.trim() && agent.goal.trim())
  const openEditor = () => { setDraftAgents(agents.map((agent) => ({ ...agent }))); setEditing(true) }
  const runRailAction = (action: () => Promise<unknown>) => { setDrawer(false); void action() }
  const submitMessage = async (event: FormEvent) => { event.preventDefault(); const value = composer; if (!value.trim()) return; setComposer(''); await controller.sendUserMessage(value) }
  const rail = <aside ref={railElement} id="room-agent-rail" className={`agent-rail ${drawer ? 'open' : ''}`} aria-label={t('agentRail')} aria-hidden={mobile && !drawer ? true : undefined} inert={mobile && !drawer ? true : undefined}>
    <div className="rail-mobile-head"><strong>{t('agentRail')}</strong><button aria-label={t('close')} onClick={() => setDrawer(false)}>×</button></div>
    <div className="rail-room"><span className="eyebrow">{t('agents')}</span>{agents.filter((agent) => agent.enabled).map((agent) => <div className="rail-agent" key={agent.id}><span>{agent.avatar}</span><div><strong>{agent.name}</strong><small>{agent.role}</small></div></div>)}<button ref={editButton} className="text-button" onClick={openEditor}>{t('editAgents')} ↗</button></div>
    <div className="rail-controls"><span className="eyebrow">{t('controls')}</span><div className="run-progress"><strong>{run?.turnsCompleted ?? 0}<small> / {run?.turnLimit ?? '—'}</small></strong><span>{t('turns')}</span></div><div className="progress"><i style={{ width: `${run ? (run.turnsCompleted / run.turnLimit) * 100 : 0}%` }}/></div><p>{t('totalTurns')}: {room.totalTurnsCompleted}</p>
      {(room.status === 'paused' || room.status === 'draft') ? <button className="button primary full" onClick={() => runRailAction(controller.resume)}>{t('resume')} ▶</button> : room.status === 'running' ? <button className="button secondary full" onClick={() => runRailAction(controller.pause)}>{t('pause')} Ⅱ</button> : null}
      {streaming && <button className="button danger-button full" onClick={() => runRailAction(controller.stop)}>{t('stop')} ■</button>}
    </div>
    <button className="text-button danger rail-delete" onClick={async () => { if (confirm(t('deleteConfirm'))) { await deleteRoomCascade(roomId); navigate('/') } }}>{t('deleteRoom')}</button>
  </aside>
  return <main className="room-shell">{rail}<section className="chat-panel">
    <header className="room-header"><button ref={drawerButton} className="drawer-button" aria-label={t('menu')} aria-expanded={drawer} aria-controls="room-agent-rail" onClick={() => setDrawer(true)}>☰</button><div><h1>{room.title}</h1><p>{room.topic}</p></div><span className={`status ${room.status}`}>{t(room.status)}</span></header>
    {!controller.driver && <div className="follower-note" role="status">{t('follower')}</div>}{controller.busy && <div className="busy-note" role="status" aria-live="polite">{t('busy')}</div>}{controller.notice && <RoomNotice code={controller.notice} t={t}/>}
    {controller.challengeSiteKey && <div className="challenge-banner" role="group" aria-label={t('challenge')}><p>{controller.challengeVerifying ? t('verificationInProgress') : t('challenge')}</p><TurnstileChallenge siteKey={controller.challengeSiteKey} onToken={controller.verifyChallenge} onError={controller.challengeError}/></div>}
    <div className="messages" ref={scroll} onScroll={(event) => { const element = event.currentTarget; setNearBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 120) }}>
      <div className="messages-inner">{!messages.length && <div className="empty-chat"><div>✦</div><p>{t('emptyChat')}</p></div>}{messages.map((message) => <MessageRow key={message.id} message={message} agents={agents} t={t} onRetry={() => void controller.retry(message)} onSkip={() => void controller.skip(message)} onKeep={() => void controller.keepPartial(message)}/>)}</div>
    </div>
    {!nearBottom && <button className="jump-bottom" onClick={() => { setNearBottom(true); scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }) }}>↓ {t('jumpBottom')}</button>}
    {room.status === 'finished' && <div className="continue-bar"><span>{t('continueRun')}</span>{TURN_LIMITS.map((limit) => <button key={limit} onClick={() => void controller.continueRun(limit)}>{limit} {t('turns')}</button>)}</div>}
    <form className="composer" onSubmit={(event) => void submitMessage(event)}><textarea aria-label={t('messagePlaceholder')} rows={1} maxLength={4000} value={composer} onChange={(event) => setComposer(event.target.value)} placeholder={t('messagePlaceholder')} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }}/><button className="send-button" disabled={!composer.trim()} aria-label={t('send')}>↑</button></form>
  </section>
  {drawer && <button className="drawer-scrim" aria-label={t('close')} onClick={() => setDrawer(false)}/>}
  {editing && <div className="modal-backdrop"><section ref={modal} className="modal" role="dialog" aria-modal="true" aria-labelledby="agent-modal-title"><header><h2 id="agent-modal-title">{t('editAgents')}</h2><button aria-label={t('close')} onClick={() => setEditing(false)}>×</button></header><div className="modal-scroll">{draftAgents.map((agent, index) => <AgentEditor key={agent.id} agent={agent} index={index} canRemove={draftAgents.length > 2} t={t} onChange={(next) => setDraftAgents((all) => all.map((item) => item.id === agent.id ? next : item))} onRemove={() => setDraftAgents((all) => all.filter((item) => item.id !== agent.id))}/>)}{draftAgents.length < 6 && <button className="button secondary full" onClick={() => setDraftAgents((all) => [...all, blankAgent(roomId)])}>+ {t('addAgent')}</button>}</div><footer><button className="button secondary" onClick={() => setEditing(false)}>{t('cancel')}</button><button className="button primary" disabled={!editorValid} onClick={async () => { if (await controller.saveAgents(draftAgents)) setEditing(false) }}>{t('save')}</button></footer></section></div>}
  </main>
}

function Settings({ t, language, setLanguage, theme, setTheme }: { t: ReturnType<typeof translator>; language: Language; setLanguage: (value: Language) => void; theme: ThemePreference; setTheme: (value: ThemePreference) => void }) {
  const [confirmClear, setConfirmClear] = useState(false)
  return <main className="simple-page"><p className="eyebrow">{t('preferences')}</p><h1>{t('settings')}</h1>
    <section className="settings-section"><h2>{t('appearance')}</h2><div className="choice-grid">{(['system', 'light', 'dark'] as const).map((item) => <button className={theme === item ? 'selected' : ''} key={item} onClick={() => setTheme(item)} aria-pressed={theme === item}><span className={`theme-preview ${item}`}/><strong>{t(item)}</strong></button>)}</div></section>
    <section className="settings-section"><h2>{t('language')}</h2><div className="inline-choices"><button className={language === 'en' ? 'selected' : ''} onClick={() => setLanguage('en')}>{t('english')}</button><button className={language === 'zh' ? 'selected' : ''} onClick={() => setLanguage('zh')}>{t('chinese')}</button></div></section>
    <section className="settings-section privacy-card"><h2>{t('dataPrivacy')}</h2><p>{t('privacyText')}</p><hr/><h3>{t('clearData')}</h3><p>{t('clearExplain')}</p><button className="button danger-button" onClick={() => setConfirmClear(true)}>{t('clearData')}</button></section>
    {confirmClear && <div className="modal-backdrop"><section className="confirm-dialog" role="alertdialog" aria-modal="true"><h2>{t('clearConfirm')}</h2><div><button className="button secondary" onClick={() => setConfirmClear(false)}>{t('cancel')}</button><button className="button danger-button" onClick={async () => { await clearAllLocalData(); localStorage.removeItem('agentroom:lastRoomId'); setConfirmClear(false) }}>{t('clear')}</button></div></section></div>}
  </main>
}

function About({ t }: { t: ReturnType<typeof translator> }) {
  return <main className="simple-page about-page"><p className="eyebrow">Open source · PRIVATE_BETA</p><h1>{t('about')}</h1><p className="about-lead">{t('aboutBody')}</p><div className="principles"><div><span>01</span><h2>{t('noSignup')}</h2><p>{t('anonymousExplain')}</p></div><div><span>02</span><h2>{t('localFirst')}</h2><p>{t('privacyText')}</p></div><div><span>03</span><h2>{t('sharedCapacity')}</h2><p>{t('capacityExplain')}</p></div></div><div className="about-actions"><a className="button primary" href="https://github.com/colasun-ai/agent-room" target="_blank" rel="noopener noreferrer">{t('source')} ↗</a><a className="button secondary" href="https://github.com/colasun-ai/agent-room#self-deploy" target="_blank" rel="noopener noreferrer">{t('deployOwn')} ↗</a></div></main>
}

export default function App() {
  const path = usePath()
  const [language, setLanguageState] = useState<Language>(() => (localStorage.getItem('agentroom:language') as Language) || (navigator.language.startsWith('zh') ? 'zh' : 'en'))
  const [theme, setThemeState] = useState<ThemePreference>(() => (localStorage.getItem('agentroom:theme') as ThemePreference) || 'system')
  const t = useMemo(() => translator(language), [language])
  useEffect(() => { void recoverInterruptedMessages() }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme; document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'; localStorage.setItem('agentroom:theme', theme); localStorage.setItem('agentroom:language', language) }, [language, theme])
  const setLanguage = (value: Language) => setLanguageState(value)
  const setTheme = (value: ThemePreference) => setThemeState(value)
  const pathname = path.split('?')[0]
  const roomMatch = pathname.match(/^\/room\/([^/]+)$/)
  const page = roomMatch ? <RoomPage roomId={decodeURIComponent(roomMatch[1])} t={t}/> : pathname === '/new' ? <NewRoom t={t}/> : pathname === '/settings' ? <Settings t={t} language={language} setLanguage={setLanguage} theme={theme} setTheme={setTheme}/> : pathname === '/about' ? <About t={t}/> : <Landing t={t}/>
  return <div className="app"><Header t={t}/>{page}<footer className="site-footer"><span>AgentRoom · {t('beta')}</span><span>{t('sharedCapacity')} · {t('localFirst')}</span></footer></div>
}
