import { Children, cloneElement, isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import type { LocalAgent } from '../model'
import { normalizeAgentName } from '../../shared/protocol'

function Highlighted({ children, agents }: { children: ReactNode; agents: LocalAgent[] }) {
  const names = new Map(agents.filter((agent) => agent.enabled).map((agent) => [agent.normalizedName, agent.name]))
  const visit = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') {
      const parts = node.split(/(@[\p{L}\p{N}_-]+)/gu)
      return parts.map((part, index) => {
        if (!part.startsWith('@') || !names.has(normalizeAgentName(part.slice(1)))) return part
        return <mark className="mention" key={`${part}-${index}`}>{part}</mark>
      })
    }
    if (isValidElement<{ children?: ReactNode }>(node) && node.props.children) return cloneElement(node, {}, Children.map(node.props.children, visit))
    return node
  }
  return <>{Children.map(children, visit)}</>
}

function safeUrl(url: string): string {
  if (url.startsWith('/') || url.startsWith('#')) return url
  try { const parsed = new URL(url); return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : '' } catch { return '' }
}

function plainText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return plainText(node.props.children)
  return ''
}

export function MarkdownMessage({ content, agents }: { content: string; agents: LocalAgent[] }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    urlTransform={safeUrl}
    components={{
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: () => null,
      p: ({ children }) => <p><Highlighted agents={agents}>{children}</Highlighted></p>,
      li: ({ children }) => <li><Highlighted agents={agents}>{children}</Highlighted></li>,
      code: ({ className, children, ...props }) => {
        const value = plainText(children).replace(/\n$/, '')
        const block = Boolean(className) || value.includes('\n')
        if (!block) return <code {...props}>{children}</code>
        const language = className?.replace('language-', '') || 'text'
        return <span className="code-shell"><span className="code-tools"><span>{language}</span><button type="button" onClick={() => void navigator.clipboard.writeText(value)}>Copy</button></span><code className={className} {...props}>{children}</code></span>
      },
    }}
  >{content}</ReactMarkdown>
}
