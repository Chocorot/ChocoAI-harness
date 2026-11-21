'use client'

import { MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@chocorot/design/ui/alert-dialog'
import { Button } from '@chocorot/design/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@chocorot/design/ui/dropdown-menu'
import { cn } from '@chocorot/design/lib/utils'
import { chatTitle, type SessionRow } from './lib/api'

const when = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/** The saved chats: used in the desktop sidebar and in the phone's Chats sheet. */
export function ChatList({ sessions, sid, onOpen, onNew, onRename, onDelete, extra }: {
  sessions: SessionRow[]
  sid: number | null
  onOpen: (id: number) => void
  onNew: () => void
  onRename: (id: number, title: string) => Promise<void>
  onDelete: (id: number) => Promise<void>
  extra?: React.ReactNode
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [asking, setAsking] = useState<SessionRow | null>(null)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Button onClick={onNew} className="w-full"><Plus /> New chat</Button>
      {extra}
      <div className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1" data-testid="chat-list">
        {sessions.length ? null : <p className="text-muted-foreground px-2 py-6 text-center text-sm">No chats yet.<br />Start one below.</p>}
        {sessions.map((s) =>
          editing === s.id ? (
            <input
              key={s.id}
              autoFocus
              defaultValue={chatTitle(s)}
              maxLength={80}
              aria-label="Chat name"
              enterKeyHint="done"
              className="bg-background border-ring w-full rounded-md border px-2 py-1.5 text-sm outline-none"
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') setEditing(null)
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              onBlur={async (e) => {
                const v = e.currentTarget.value.trim()
                setEditing(null)
                if (v && v !== chatTitle(s)) await onRename(s.id, v)
              }}
            />
          ) : (
            <div key={s.id} data-on={s.id === sid} className="group hover:bg-accent data-[on=true]:bg-accent flex items-center rounded-md">
              <button type="button" onClick={() => onOpen(s.id)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                <span className="block truncate text-sm">{chatTitle(s)}</span>
                <small className="text-muted-foreground text-xs">{when(s.created)}</small>
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="Chat options" className={cn('md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 aria-expanded:opacity-100')}><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setEditing(s.id)}><Pencil /> Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setAsking(s)}><Trash2 /> Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ),
        )}
      </div>
      <AlertDialog open={asking !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
            <AlertDialogDescription>“{asking ? chatTitle(asking) : ''}” and its files are removed for good.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => asking && void onDelete(asking.id)}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
