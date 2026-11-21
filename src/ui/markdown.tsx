'use client'

import { Check, Copy } from 'lucide-react'
import { memo, useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@chocorot/design/ui/button'

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;opacity:0'
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

export function CopyButton({ text, label = 'Copy', className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      className={className}
      onClick={async () => {
        await copyText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1500)
      }}
    >
      {done ? <Check /> : <Copy />}
    </Button>
  )
}

const textOf = (n: ReactNode): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(textOf).join('') : '')

// react-markdown escapes HTML (no rehype-raw), drops javascript: links, and we never render model-supplied images.
const components = {
  a: ({ node: _n, ...p }: any) => <a {...p} target="_blank" rel="noopener noreferrer" />,
  img: () => null,
  pre: ({ node: _n, children }: any) => {
    const code = children?.props
    const lang = /language-(\S+)/.exec(code?.className ?? '')?.[1] ?? ''
    const body = textOf(code?.children).replace(/\n$/, '')
    return (
      <div className="bg-card overflow-hidden rounded-lg border">
        <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1 text-xs">
          <span>{lang}</span>
          <CopyButton text={body} label="Copy code" />
        </div>
        <pre>{children}</pre>
      </div>
    )
  },
  table: ({ node: _n, ...p }: any) => <div className="overflow-x-auto"><table {...p} /></div>,
}

/** Memoised, so a streaming answer re-renders only when its own text changed. */
export const Md = memo(function Md({ text }: { text: string }) {
  return <div className="md"><Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>
})
