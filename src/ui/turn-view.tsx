'use client'

import { AlertTriangle, Check, ChevronDown, Loader2, RefreshCw, Sparkles, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@chocorot/design/ui/button'
import { cn } from '@chocorot/design/lib/utils'
import { iconFor } from './icons'
import { argSummary, ERROR_ICON, splitThink, toolUi, type Part, type TurnModel } from './lib/turn'
import { Md } from './markdown'

const secs = (ms: number) => (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + 's'
const thought = (ms: number) => (ms < 1000 ? 'Thought for a moment' : `Thought for ${Math.round(ms / 1000)}s`)

/** Re-renders once a second while `on` (a running timer or a retry countdown). */
function useSecond(on: boolean) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
}

function Fold({ head, children, open, onToggle }: { head: React.ReactNode; children: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <div className="bg-card rounded-lg border text-sm">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {head}
        <ChevronDown className={cn('text-muted-foreground ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open ? <div className="border-t px-3 py-2">{children}</div> : null}
    </div>
  )
}

function Think({ p }: { p: Extract<Part, { k: 'think' }> | { raw: string; t0: number; ms: number | null } }) {
  const running = p.ms === null
  useSecond(running)
  const [open, setOpen] = useState<boolean | null>(null) // null = follow the default: open while thinking, folded after
  const shown = open ?? running
  if (!running && !p.raw.trim()) return null
  return (
    <Fold
      open={shown}
      onToggle={() => setOpen(!shown)}
      head={
        <>
          <Sparkles className={cn('text-primary size-4 shrink-0', running && 'animate-pulse')} aria-hidden />
          <span className={cn('font-medium', running && 'shimmer')}>{running ? 'Thinking…' : thought(p.ms!)}</span>
          {running ? <span className="text-muted-foreground text-xs">{secs(Date.now() - p.t0)}</span> : null}
        </>
      }
    >
      <p className="text-muted-foreground max-h-48 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap">{p.raw.trim()}</p>
    </Fold>
  )
}

function TextPart({ p }: { p: Extract<Part, { k: 'text' }> }) {
  const { think, answer } = splitThink(p.raw)
  const inlineThink = think || /^\s*<think>/.test(p.raw)
  return (
    <>
      {inlineThink ? <Think p={{ raw: think, t0: 0, ms: answer ? 0 : null }} /> : null}
      {answer ? <Md text={answer} /> : null}
    </>
  )
}

function ToolCard({ p }: { p: Extract<Part, { k: 'tool' }> }) {
  const ui = toolUi(p.name)
  const Icon = iconFor(ui.icon)
  useSecond(p.state === 'running')
  const [open, setOpen] = useState<boolean | null>(null)
  const shown = open ?? p.state === 'fail'
  const args = typeof p.args === 'string' ? p.args : JSON.stringify(p.args, null, 2)
  return (
    <Fold
      open={shown}
      onToggle={() => setOpen(!shown)}
      head={
        <>
          {p.state === 'running' ? <Loader2 className="text-muted-foreground size-4 shrink-0 animate-spin" aria-label="Running" /> : p.state === 'ok' ? <Check className="text-primary size-4 shrink-0" aria-label="Done" /> : <X className="text-destructive size-4 shrink-0" aria-label="Failed" />}
          <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
          <span className="font-medium">{ui.label}</span>
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{argSummary(p.name, p.args)}</span>
          {p.ms !== null ? <span className="text-muted-foreground text-xs">{secs(p.ms)}</span> : null}
        </>
      }
    >
      <div className="space-y-2">
        <pre className="bg-muted/50 max-h-40 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">{(args ?? '').slice(0, 3000)}</pre>
        {p.sub.length ? <div className="space-y-2 border-l-2 pl-3">{p.sub.map((s) => (s.k === 'tool' ? <ToolCard key={s.id} p={s} /> : null))}</div> : null}
        {p.note ? <p className="text-muted-foreground text-xs whitespace-pre-wrap">{p.note}</p> : null}
        {p.res !== null ? <pre className="bg-muted/50 max-h-60 overflow-auto rounded-md p-2 text-xs whitespace-pre-wrap">{p.res}</pre> : null}
      </div>
    </Fold>
  )
}

function Plan({ p }: { p: Extract<Part, { k: 'plan' }> }) {
  const done = p.steps.filter((s) => s.status === 'done').length
  return (
    <div className="bg-card rounded-lg border p-3 text-sm">
      <div className="mb-2 flex items-center justify-between font-medium"><span>Plan</span><span className="text-muted-foreground text-xs">{done}/{p.steps.length}</span></div>
      <ol className="space-y-1.5">
        {p.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2" data-s={s.status}>
            <span className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', s.status === 'done' && 'bg-primary text-primary-foreground border-transparent', s.status === 'doing' && 'border-primary')}>
              {s.status === 'done' ? <Check className="size-3" aria-hidden /> : null}
            </span>
            <span className={cn(s.status === 'done' && 'text-muted-foreground line-through')}>{s.text}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

function StatusLine({ s }: { s: NonNullable<TurnModel['status']> }) {
  useSecond(Boolean(s.countdown))
  const Icon = iconFor(s.icon)
  let text = s.text
  if (s.countdown) {
    const left = Math.max(0, s.countdown.from - Math.floor((Date.now() - s.countdown.at) / 1000))
    text = left > 0 ? `${s.text} Retrying in ${left}s…` : `${s.text} Retrying…`
  }
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
      <Icon className={cn('size-4', s.icon === 'sparkle' && 'animate-pulse')} aria-hidden />
      <span className={cn(s.shimmer && 'shimmer')}>{text}</span>
    </div>
  )
}

export function TurnView({ turn, onRetry, onContinue }: { turn: TurnModel; version: number; onRetry?: () => void; onContinue?: () => void }) {
  return (
    <div className="min-w-0 flex-1 space-y-3">
      {turn.parts.map((p) => {
        switch (p.k) {
          case 'think': return <Think key={p.id} p={p} />
          case 'text': return <TextPart key={p.id} p={p} />
          case 'tool': return <ToolCard key={p.id} p={p} />
          case 'plan': return <Plan key={p.id} p={p} />
          case 'notice':
            return (
              <div key={p.id} className="bg-card flex items-start gap-3 rounded-lg border p-3 text-sm">
                <AlertTriangle className="text-muted-foreground mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="space-y-2"><div>{p.msg}</div>{p.kind === 'budget' && onContinue ? <Button size="sm" variant="outline" onClick={onContinue}>Continue</Button> : null}</div>
              </div>
            )
          case 'error': {
            const Icon = iconFor(ERROR_ICON[p.kind ?? ''] ?? 'alert')
            return (
              <div key={p.id} role="alert" className="border-destructive/40 bg-destructive/10 flex items-start gap-3 rounded-lg border p-3 text-sm">
                <Icon className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden />
                <div className="space-y-1">
                  <div>{p.msg}</div>
                  {p.rid ? <small className="text-muted-foreground block">Reference {p.rid}</small> : null}
                  {p.retryable && onRetry ? <Button size="sm" variant="outline" onClick={onRetry}><RefreshCw /> Try again</Button> : null}
                </div>
              </div>
            )
          }
        }
      })}
      {turn.status ? <StatusLine s={turn.status} /> : null}
    </div>
  )
}
