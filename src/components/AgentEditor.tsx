import { normalizeAgentName } from '../../shared/protocol'
import type { LocalAgent } from '../model'
import type { TranslationKey } from '../i18n'

export function blankAgent(roomId: string): LocalAgent {
  return { id: crypto.randomUUID(), roomId, name: '', normalizedName: '', role: '', avatar: '✦', personality: '', goal: '', enabled: true, temperature: 0.7 }
}

export function AgentEditor({ agent, index, canRemove, t, onChange, onRemove }: {
  agent: LocalAgent; index: number; canRemove: boolean; t: (key: TranslationKey) => string; onChange: (agent: LocalAgent) => void; onRemove: () => void
}) {
  const patch = (changes: Partial<LocalAgent>) => onChange({ ...agent, ...changes, ...(changes.name !== undefined ? { normalizedName: normalizeAgentName(changes.name) } : {}) })
  return <article className="agent-editor">
    <div className="agent-editor-head">
      <span className="agent-number">{String(index + 1).padStart(2, '0')}</span>
      <label className="switch"><input type="checkbox" checked={agent.enabled} onChange={(event) => patch({ enabled: event.target.checked })}/><span>{t('enabled')}</span></label>
      <button type="button" className="text-button danger" disabled={!canRemove} onClick={onRemove}>{t('removeAgent')}</button>
    </div>
    <div className="editor-grid compact-grid">
      <label className="avatar-field"><span>{t('avatar')}</span><input aria-label={`${t('avatar')} ${index + 1}`} maxLength={4} value={agent.avatar} onChange={(event) => patch({ avatar: event.target.value })}/></label>
      <label><span>{t('name')}</span><input required maxLength={28} value={agent.name} onChange={(event) => patch({ name: event.target.value })}/></label>
      <label><span>{t('role')}</span><input required maxLength={60} value={agent.role} onChange={(event) => patch({ role: event.target.value })}/></label>
    </div>
    <div className="editor-grid">
      <label><span>{t('personality')}</span><textarea required maxLength={600} rows={2} value={agent.personality} onChange={(event) => patch({ personality: event.target.value })}/></label>
      <label><span>{t('goal')}</span><textarea required maxLength={600} rows={2} value={agent.goal} onChange={(event) => patch({ goal: event.target.value })}/></label>
    </div>
    <details>
      <summary>{t('advanced')}</summary>
      <label><span>{t('custom')}</span><textarea maxLength={2000} rows={3} value={agent.customInstructions ?? ''} onChange={(event) => patch({ customInstructions: event.target.value || undefined })}/></label>
      <label className="range-label"><span>{t('temperature')} · {(agent.temperature ?? 0.7).toFixed(1)}</span><input type="range" min="0.2" max="1.2" step="0.1" value={agent.temperature ?? 0.7} onChange={(event) => patch({ temperature: Number(event.target.value) })}/></label>
    </details>
  </article>
}
