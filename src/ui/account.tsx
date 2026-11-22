'use client'

import { Download, LogIn, LogOut, Monitor, Moon, Sun, Trash2, UserCog } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { Avatar, AvatarFallback } from '@chocorot/design/ui/avatar'
import { Button } from '@chocorot/design/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@chocorot/design/ui/dialog'
import type { Me } from './lib/api'

const THEMES = [['system', Monitor, 'System'], ['light', Sun, 'Light'], ['dark', Moon, 'Dark']] as const

export function AccountDialog({ open, onOpenChange, me, hasPublicChat, install, onReset, onSignOut }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  me: Me
  hasPublicChat: boolean
  install: { prompt: () => Promise<void> } | null
  onReset: () => void
  onSignOut: () => void
}) {
  const { theme = 'system', setTheme } = useTheme()
  const [armed, setArmed] = useState(false) // erasing a chat takes a second press (no native confirm dialogs)
  const signedIn = Boolean(me.address)
  const ios = typeof navigator !== 'undefined' && /iphone|ipad/i.test(navigator.userAgent) && !(navigator as any).standalone

  return (
    <Dialog open={open} onOpenChange={(o) => { setArmed(false); onOpenChange(o) }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader><DialogTitle>Account</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {signedIn ? (
            <div className="bg-card flex items-center gap-3 rounded-lg border p-3">
              <Avatar><AvatarFallback>{me.address![0]!.toUpperCase()}</AvatarFallback></Avatar>
              <div className="min-w-0"><b className="block truncate text-sm">{me.address}</b><small className="text-muted-foreground">{me.capabilities.shell ? 'Shell access enabled' : 'Signed in'}</small></div>
            </div>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">You are using the public chat. It has no tools, and your conversation is stored only in this browser.</p>
              {me.capabilities.login ? <Button className="w-full" onClick={() => location.assign('/api/auth/sso/start')}><LogIn /> Sign in with Choco</Button> : null}
            </>
          )}
          {signedIn && me.capabilities.accountUrl ? (
            <Button variant="outline" className="w-full" asChild><a href={me.capabilities.accountUrl} target="_blank" rel="noopener noreferrer"><UserCog /> Account settings</a></Button>
          ) : null}
          {signedIn ? <p className="text-muted-foreground -mt-1 text-xs">Your name, password and signed-in devices are managed in your Choco account.</p> : null}
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="Theme">
            {THEMES.map(([id, Icon, label]) => <Button key={id} variant={theme === id ? 'default' : 'outline'} aria-pressed={theme === id} onClick={() => setTheme(id)}><Icon /> {label}</Button>)}
          </div>
          {install ? <Button variant="outline" className="w-full" onClick={() => void install.prompt()}><Download /> Install app</Button> : ios ? <p className="text-muted-foreground text-sm">To install: tap Share, then Add to Home Screen.</p> : null}
          {!signedIn && hasPublicChat ? (
            <Button variant="destructive" className="w-full" onClick={() => { if (!armed) return setArmed(true); setArmed(false); onReset() }}><Trash2 /> {armed ? 'Tap again to erase this chat' : 'Reset chat'}</Button>
          ) : null}
          {signedIn ? <Button variant="outline" className="w-full" onClick={onSignOut}><LogOut /> Sign out</Button> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
