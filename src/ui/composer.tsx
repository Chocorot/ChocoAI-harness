'use client'

import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X } from 'lucide-react'
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import { toast } from 'sonner'
import { Button } from '@chocorot/design/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@chocorot/design/ui/dropdown-menu'
import { cn } from '@chocorot/design/lib/utils'
import { extOf, fmtSize, MAX_DOC_BYTES, MAX_FILES, MAX_TOTAL_B64, shrinkImage, toBase64, type Me } from './lib/api'

export type Pending = { kind: 'image' | 'file'; name: string; data: string; url?: string; size: number }

export function AttChip({ a, onRemove }: { a: { kind: 'image' | 'file'; name: string; url?: string; size?: number }; onRemove?: () => void }) {
  const body = (
    <>
      {a.kind === 'image' && a.url ? <img src={a.url} alt="" className="size-9 rounded object-cover" /> : <span className="bg-muted grid size-9 place-items-center rounded">{a.kind === 'image' ? <ImageIcon className="size-4" /> : <FileText className="size-4" />}</span>}
      <span className="min-w-0 text-left text-xs"><b className="block max-w-40 truncate font-medium">{a.name}</b>{a.size ? <small className="text-muted-foreground">{fmtSize(a.size)}</small> : null}</span>
    </>
  )
  const cls = 'bg-card flex items-center gap-2 rounded-lg border p-1.5 pr-2'
  return (
    <span className={cn(cls, 'relative')}>
      {a.url && !onRemove ? <a href={a.url} download={a.name} className="flex items-center gap-2">{body}</a> : body}
      {onRemove ? <button type="button" onClick={onRemove} aria-label={`Remove ${a.name}`} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button> : null}
    </span>
  )
}

export function Composer({ me, busy, effort, onEffort, onSend, onStop, fine }: {
  me: Me
  busy: boolean
  effort: string
  onEffort: (id: string) => void
  onSend: (text: string, atts: Pending[]) => void
  onStop: () => void
  fine: string
}) {
  const [text, setText] = useState('')
  const [atts, setAtts] = useState<Pending[]>([])
  const [drag, setDrag] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const caps = me.capabilities.attachments ?? { image: false, documents: [] }
  const canAttach = caps.image || caps.documents.length > 0
  const levels = me.capabilities.effort?.levels ?? []
  const level = Math.max(0, levels.findIndex((l) => l.id === effort))
  const can = Boolean(text.trim() || atts.length)

  const grow = () => {
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 152) + 'px'
  }

  async function addFiles(files: File[]) {
    let list = atts
    for (const f of files) {
      if (list.length >= MAX_FILES) { toast(`At most ${MAX_FILES} attachments.`); break }
      try {
        if (f.type.startsWith('image/')) {
          if (!caps.image) { toast("This assistant can't look at photos yet."); continue }
          if (list.some((a) => a.kind === 'image')) { toast('One photo per message.'); continue }
          const blob = await shrinkImage(f)
          list = [...list, { kind: 'image', name: f.name.replace(/\.[^.]*$/, '') + '.jpg', data: await toBase64(blob), url: URL.createObjectURL(blob), size: blob.size }]
        } else {
          if (!caps.documents.includes(extOf(f.name))) { toast(`Can't read ${extOf(f.name) || 'that kind of'} files.`); continue }
          if (f.size > MAX_DOC_BYTES) { toast(`${f.name} is too large (limit ${fmtSize(MAX_DOC_BYTES)}).`); continue }
          list = [...list, { kind: 'file', name: f.name, data: await toBase64(f), size: f.size }]
        }
      } catch {
        toast(`Could not read ${f.name}.`)
      }
    }
    setAtts(list)
  }

  function submit() {
    if (busy) return onStop()
    if (!can) return
    if (atts.reduce((n, a) => n + a.data.length, 0) > MAX_TOTAL_B64) return void toast('That is too much to send at once. Remove a file.')
    onSend(text.trim(), atts)
    setText('')
    setAtts([])
    requestAnimationFrame(grow)
  }

  const onPaste = (e: ClipboardEvent) => {
    const fs = [...(e.clipboardData?.files ?? [])]
    if (fs.length && canAttach) { e.preventDefault(); void addFiles(fs) }
  }
  const onDrop = (e: DragEvent) => {
    setDrag(false)
    if (canAttach && e.dataTransfer.files.length) { e.preventDefault(); void addFiles([...e.dataTransfer.files]) }
  }

  return (
    <div
      className={cn('shrink-0 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]', drag && 'bg-primary/5')}
      onDragEnter={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true) } }}
      onDragOver={(e) => { if (canAttach && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      <div className="mx-auto w-full max-w-3xl">
        {atts.length ? <div className="mb-2 flex flex-wrap gap-2">{atts.map((a, i) => <AttChip key={i} a={a} onRemove={() => setAtts(atts.filter((_, j) => j !== i))} />)}</div> : null}
        <form
          autoComplete="off"
          onSubmit={(e) => { e.preventDefault(); submit() }}
          className="bg-card focus-within:border-ring flex items-end gap-1 rounded-2xl border p-1.5"
        >
          {canAttach ? (
            <>
              <Button type="button" variant="ghost" size="icon" aria-label="Attach a file" onClick={() => file.current?.click()}><Paperclip /></Button>
              <input ref={file} type="file" multiple hidden accept={[caps.image ? 'image/*' : '', ...caps.documents].filter(Boolean).join(',')} onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
            </>
          ) : null}
          <label className="sr-only" htmlFor="message">Message</label>
          <textarea
            id="message"
            ref={area}
            rows={1}
            value={text}
            placeholder="Message ChocoAI"
            enterKeyHint="send"
            onChange={(e) => { setText(e.target.value); grow() }}
            onPaste={onPaste}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); submit() }
            }}
            className="placeholder:text-muted-foreground max-h-38 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-base outline-none"
          />
          {levels.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="ghost" size="icon" aria-label={`Thinking effort: ${levels[level]?.label}`} title={`Thinking effort: ${levels[level]?.label}`}>
                  <svg viewBox="0 0 24 24" className="size-5" aria-hidden>
                    {[[4.5, 13, 7], [10, 9, 11], [15.5, 4.5, 15.5]].slice(0, levels.length).map(([x, y, h], n) => <rect key={n} x={x} y={y} width={4} height={h} rx={1.6} fill="currentColor" fillOpacity={n <= level ? 1 : 0.28} />)}
                  </svg>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="top" className="w-60">
                <DropdownMenuRadioGroup value={effort} onValueChange={onEffort}>
                  {levels.map((l) => (
                    <DropdownMenuRadioItem key={l.id} value={l.id}><span><b className="block text-sm font-medium">{l.label}</b><small className="text-muted-foreground">{l.desc}</small></span></DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          <Button type="submit" size="icon" aria-label={busy ? 'Stop' : 'Send'} disabled={!busy && !can} className="rounded-xl">{busy ? <Square className="fill-current" /> : <ArrowUp />}</Button>
        </form>
        <p className="text-muted-foreground mt-1.5 text-center text-xs">{fine}</p>
      </div>
    </div>
  )
}
