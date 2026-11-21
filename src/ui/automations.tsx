'use client'

import { Clock, MessageSquare, Play, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@chocorot/design/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@chocorot/design/ui/dialog'
import { Input } from '@chocorot/design/ui/input'
import { Label } from '@chocorot/design/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@chocorot/design/ui/select'
import { Textarea } from '@chocorot/design/ui/textarea'
import { cn } from '@chocorot/design/lib/utils'
import { api } from './lib/api'

const INTERVALS: Array<[number, string]> = [[15, '15 minutes'], [30, '30 minutes'], [60, 'hour'], [120, '2 hours'], [360, '6 hours'], [720, '12 hours'], [1440, 'day']] // values are minutes
type Schedule = { kind: 'interval'; every_min: number } | { kind: 'daily'; at: string }
type Auto = { id: number; name: string; prompt: string; schedule: Schedule; enabled: boolean; nextRun: number | null; lastRun: number | null; lastStatus: string | null; lastSession: number | null }

const describe = (s: Schedule) => (s.kind === 'daily' ? `Every day at ${s.at}` : `Every ${INTERVALS.find(([n]) => n === s.every_min)?.[1] ?? `${s.every_min} minutes`}`)
const stamp = (t: number) => new Date(t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

export function AutomationsDialog({ open, onOpenChange, tz, onOpenChat }: { open: boolean; onOpenChange: (o: boolean) => void; tz: string; onOpenChat: (id: number) => void }) {
  const [items, setItems] = useState<Auto[] | null>(null)
  const [error, setError] = useState('')
  const [form, setForm] = useState<{ edit: Auto | null } | null>(null)

  const load = useCallback(async () => {
    try { setItems((await api<{ automations: Auto[] }>('GET', '/api/automations')).automations); setError('') } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { if (open) { setForm(null); void load() } }, [open, load])

  const act = async (fn: () => Promise<unknown>, after = load) => {
    try { await fn(); await after() } catch (e) { toast((e as Error).message) }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Automations</DialogTitle>
          <DialogDescription>A saved prompt that runs by itself on a schedule. It can search the web and read pages, but never uses the shell. Each run appears as a chat.</DialogDescription>
        </DialogHeader>
        {form ? (
          <AutoForm edit={form.edit} tz={tz} onCancel={() => setForm(null)} onSaved={async () => { setForm(null); await load() }} />
        ) : (
          <div className="space-y-3">
            <Button className="w-full" onClick={() => setForm({ edit: null })}><Plus /> New automation</Button>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            {items && !items.length ? <p className="text-muted-foreground py-4 text-center text-sm">No automations yet.</p> : null}
            {items?.map((a) => (
              <div key={a.id} className="bg-card space-y-2 rounded-lg border p-3">
                <div className="flex items-center justify-between gap-2">
                  <button type="button" className="min-w-0 truncate text-left font-medium hover:underline" onClick={() => setForm({ edit: a })}>{a.name}</button>
                  <button type="button" role="switch" aria-checked={a.enabled} aria-label="Enabled" onClick={() => act(() => api('PATCH', `/api/automations/${a.id}`, { enabled: !a.enabled }))}
                    className={cn('relative h-6 w-10 shrink-0 rounded-full border transition-colors', a.enabled ? 'bg-primary border-transparent' : 'bg-muted')}>
                    <span className={cn('bg-background absolute top-0.5 left-0.5 size-4.5 rounded-full transition-transform', a.enabled && 'translate-x-4')} />
                  </button>
                </div>
                <p className="text-muted-foreground text-sm">{describe(a.schedule)}{a.enabled && a.nextRun ? ` · next ${stamp(a.nextRun)} (your time)` : ' · paused'}</p>
                <p className={cn('text-xs', a.lastRun && (a.lastStatus === 'ok' ? 'text-primary' : 'text-destructive'))}>{a.lastRun ? `Last run ${stamp(a.lastRun)}: ${a.lastStatus}` : 'Not run yet'}</p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => act(async () => { await api('POST', `/api/automations/${a.id}/run`, {}); toast('Started. The result shows up in your chats.') }, async () => { setTimeout(load, 4000) })}><RefreshCw /> Run now</Button>
                  {a.lastSession ? <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onOpenChat(a.lastSession!) }}><MessageSquare /> Last result</Button> : null}
                  <Button size="sm" variant="destructive" onClick={() => act(() => api('DELETE', `/api/automations/${a.id}`))}><Trash2 /> Delete</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function AutoForm({ edit, tz, onCancel, onSaved }: { edit: Auto | null; tz: string; onCancel: () => void; onSaved: () => void }) {
  const s = edit?.schedule ?? { kind: 'interval' as const, every_min: 60 }
  const [name, setName] = useState(edit?.name ?? '')
  const [prompt, setPrompt] = useState(edit?.prompt ?? '')
  const [kind, setKind] = useState<'interval' | 'daily'>(s.kind)
  const [every, setEvery] = useState(String(s.kind === 'interval' && INTERVALS.some(([n]) => n === s.every_min) ? s.every_min : 60))
  const [at, setAt] = useState(s.kind === 'daily' ? s.at : '08:00')
  const [error, setError] = useState('')

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const body = { name, prompt, schedule: kind === 'daily' ? { kind, at } : { kind, every_min: Number(every) } }
    try {
      await (edit ? api('PATCH', `/api/automations/${edit.id}`, body) : api('POST', '/api/automations', body))
      onSaved()
    } catch (x) { setError((x as Error).message) }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <div className="space-y-1.5"><Label htmlFor="a-name">Name</Label><Input id="a-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required autoComplete="off" autoFocus /></div>
      <div className="space-y-1.5"><Label htmlFor="a-prompt">What should the assistant do?</Label><Textarea id="a-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} maxLength={2000} required /></div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-label="Schedule">
        <Button type="button" variant={kind === 'interval' ? 'default' : 'outline'} aria-pressed={kind === 'interval'} onClick={() => setKind('interval')}><RefreshCw /> Repeat</Button>
        <Button type="button" variant={kind === 'daily' ? 'default' : 'outline'} aria-pressed={kind === 'daily'} onClick={() => setKind('daily')}><Clock /> Daily</Button>
      </div>
      {kind === 'interval' ? (
        <div className="space-y-1.5"><Label>Repeat every</Label>
          <Select value={every} onValueChange={setEvery}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{INTERVALS.map(([n, l]) => <SelectItem key={n} value={String(n)}>{l}</SelectItem>)}</SelectContent></Select>
        </div>
      ) : (
        <div className="space-y-1.5"><Label htmlFor="a-at">Time</Label><Input id="a-at" type="time" value={at} onChange={(e) => setAt(e.target.value)} required /></div>
      )}
      <p className="text-muted-foreground text-xs">Times use the server's time zone ({tz}). Runs after live chats when the assistant is busy.</p>
      {error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
      <div className="flex gap-2"><Button type="submit" className="flex-1"><Play /> Save</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button></div>
    </form>
  )
}
