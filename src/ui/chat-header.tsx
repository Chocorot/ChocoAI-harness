'use client'

import { LogIn, MessagesSquare, PanelLeftClose, PanelLeftOpen, SquarePen, User } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@chocorot/design/ui/button'
import { BrandMark } from '@chocorot/design/shell/brand-mark'
import { Tooltip, TooltipContent, TooltipTrigger } from '@chocorot/design/ui/tooltip'
import { ChocoAiMark } from './brand-icon'
import type { Me } from './lib/api'

/** An icon button that says what it does (tooltip for the mouse, aria-label for everybody else). */
export function IconBtn({ label, icon: Icon, onClick }: { label: string; icon: LucideIcon; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={onClick}><Icon /></Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

export function BrandLink() {
  return (
    <a href="/" className="focus-visible:ring-ring flex shrink-0 items-center gap-2 rounded-md text-sm font-bold tracking-tight focus-visible:ring-2 focus-visible:outline-none" aria-label="ChocoAI home">
      <BrandMark icon={ChocoAiMark} />
      <span className="hidden sm:inline">ChocoAI</span>
    </a>
  )
}

const initial = (address: string | null) => (address ? address[0]!.toUpperCase() : null)

/**
 * The top bar of the chat. Everything about the sidebar is at its LEFT edge, where the sidebar is: with the sidebar open its own top row holds the
 * brand and the close button; closed, this bar starts with the open button, the brand and New chat. On a phone the first button opens the Chats
 * sheet. The title of the chat sits in the middle, the account (and Sign in, for a visitor) at the right; with the sidebar open the account is its
 * bottom row instead, so it is not shown twice.
 */
export function ChatHeader({ me, user, wide, sideVisible, title, onToggleSide, onChats, onNew, onAccount }: {
  me: Me
  user: boolean
  wide: boolean
  sideVisible: boolean
  title: string
  onToggleSide: () => void
  onChats: () => void
  onNew: () => void
  onAccount: () => void
}) {
  return (
    <header className="bg-background/95 supports-[backdrop-filter]:bg-background/80 z-30 flex h-[3.25rem] shrink-0 items-center gap-1.5 border-b px-3 backdrop-blur sm:gap-2">
      {user && wide && !sideVisible ? <IconBtn label="Open sidebar" icon={PanelLeftOpen} onClick={onToggleSide} /> : null}
      {user && !wide ? <IconBtn label="Chats" icon={MessagesSquare} onClick={onChats} /> : null}
      {!sideVisible ? <BrandLink /> : null}
      {user && !sideVisible ? <IconBtn label="New chat" icon={SquarePen} onClick={onNew} /> : null}
      <p className="text-muted-foreground min-w-0 flex-1 truncate px-1 text-sm" data-testid="chat-title">{title}</p>
      {!user && me.capabilities.login ? <Button size="sm" onClick={() => location.assign('/api/auth/sso/start')}><LogIn /> Sign in</Button> : null}
      {sideVisible ? null : (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Account" onClick={onAccount}>
            {me.address ? <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-full text-xs font-semibold">{initial(me.address)}</span> : <User />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>{me.address ?? 'Account'}</TooltipContent>
      </Tooltip>
      )}
    </header>
  )
}

/** The sidebar's top row: the brand, and the button that closes the sidebar right where the sidebar is. */
export function SidebarTop({ onClose }: { onClose: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <BrandLink />
      <IconBtn label="Close sidebar" icon={PanelLeftClose} onClick={onClose} />
    </div>
  )
}

/** The sidebar's bottom row: who you are; opens the account dialog (theme, account settings, sign out). */
export function SidebarUser({ me, onClick }: { me: Me; onClick: () => void }) {
  if (!me.address) return null
  return (
    <div className="border-t pt-2">
      <button type="button" onClick={onClick} aria-label="Account" className="hover:bg-accent focus-visible:ring-ring flex w-full items-center gap-2 rounded-md p-2 text-left focus-visible:ring-2 focus-visible:outline-none">
        <span className="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold">{initial(me.address)}</span>
        <span className="min-w-0"><b className="block truncate text-sm font-medium">{me.address}</b><small className="text-muted-foreground text-xs">{me.capabilities.shell ? 'Shell access' : 'Signed in'}</small></span>
      </button>
    </div>
  )
}
