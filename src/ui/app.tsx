'use client'

import { ArrowDown, Menu, Plus, RefreshCw, Sparkles, User } from 'lucide-react'
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { AppHeader } from '@chocorot/design/shell/app-header'
import { BrandMark } from '@chocorot/design/shell/brand-mark'
import { Button } from '@chocorot/design/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@chocorot/design/ui/dialog'
import { AccountDialog } from './account'
import { AutomationsDialog } from './automations'
import { ChatList } from './chat-list'
import { AttChip, Composer, type Pending } from './composer'
import { api, chatTitle, store, type Me, type SessionRow } from './lib/api'
import { readEvents, replay, TurnModel, type Item } from './lib/turn'
import { CopyButton } from './markdown'
import { TurnView } from './turn-view'

const HKEY = 'choco.public.chat.v1'
const EKEY = 'choco.public.effort'
const SKEY = 'choco-harness-sidebar'
const SUGGESTIONS = [ // `needs`: shown only when the caller's tools include it
  { text: 'Explain how DNS works in simple terms' },
  { text: 'Help me write a polite email declining a meeting' },
  { text: "Search the web for today's top tech news", needs: 'web_search' },
  { text: 'Make a 3-step plan to learn Python, then do step 1', needs: 'update_plan' },
]
const OFFLINE: Me = { mode: 'public', address: null, capabilities: { login: false, tools: [], shell: false, history: 'client' } }

type Hist = { role: 'user' | 'assistant'; content: string; hidden?: boolean }
type Sheet = 'chats' | 'automations' | 'account' | null

let nid = 1_000_000
const loadHistory = (): Hist[] => {
  try {
    const h = JSON.parse(store.get(HKEY) ?? 'null')
    return Array.isArray(h) ? h.filter((m) => m && typeof m.content === 'string') : []
  } catch { return [] }
}
const saveHistory = (h: Hist[]) => store.set(HKEY, JSON.stringify(h.slice(-100)))

/** A visitor's history (kept in the browser) -> what the page shows. */
function fromHistory(h: Hist[]): Item[] {
  const out: Item[] = []
  for (const m of h) {
    if (m.hidden) continue
    if (m.role === 'user') out.push({ id: ++nid, kind: 'user', text: m.content, atts: [] })
    else {
      const t = new TurnModel(false)
      t.event({ t: 'text', d: m.content })
      t.end()
      t.finished = true
      out.push({ id: ++nid, kind: 'turn', turn: t })
    }
  }
  return out
}

function useWide() {
  const [wide, setWide] = useState(true)
  useEffect(() => {
    const q = matchMedia('(min-width: 768px)')
    const f = () => setWide(q.matches)
    f()
    q.addEventListener('change', f)
    return () => q.removeEventListener('change', f)
  }, [])
  return wide
}

export function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [sid, setSidState] = useState<number | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusyState] = useState(false)
  const [effort, setEffortState] = useState('medium')
  const [title, setTitle] = useState('')
  const [sheet, setSheet] = useState<Sheet>(null)
  const [side, setSide] = useState(true)
  const [jump, setJump] = useState(false)
  const [install, setInstall] = useState<{ prompt: () => Promise<void> } | null>(null)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const wide = useWide()
  const scroller = useRef<HTMLDivElement>(null)
  // Mutable run state: the streaming loop and the poller outlive any one render, so they read this, not React state.
  const R = useRef({ sid: null as number | null, busy: false, ctl: null as AbortController | null, poll: 0 as ReturnType<typeof setInterval> | 0, polling: false, history: [] as Hist[], stick: true, me: null as Me | null, effort: 'medium', raf: 0 })
  const r = R.current
  r.me = me

  const user = () => r.me?.capabilities.history === 'user'
  const setSid = (v: number | null) => { r.sid = v; setSidState(v) }
  const setBusy = (v: boolean) => { r.busy = v; setBusyState(v) }
  const setEffort = (v: string) => { r.effort = v; setEffortState(v) }
  const bump = () => { if (!r.raf) r.raf = requestAnimationFrame(() => { r.raf = 0; redraw() }) }
  const addItem = (it: Item) => setItems((p) => [...p, it])

  // keep the newest text in view while the reply streams, unless the reader scrolled up
  useLayoutEffect(() => { if (r.stick && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight })

  const defaultEffort = (m: Me) => (m.capabilities.history === 'user' ? m.capabilities.effort?.default : store.get(EKEY) || m.capabilities.effort?.default) || 'medium'

  // ---- who am I --------------------------------------------------------------------------------------------------------------
  async function refreshMe(): Promise<Me> {
    let m: Me
    try { m = await api<Me>('GET', '/api/me') } catch { m = OFFLINE; toast("Can't reach the server.") }
    r.me = m
    setMe(m)
    setEffort(defaultEffort(m))
    if (m.capabilities.history === 'user') await refreshSessions()
    else { setSessions([]); r.history = loadHistory() }
    return m
  }
  async function refreshSessions() {
    if (!user()) return
    try { setSessions((await api<{ sessions: SessionRow[] }>('GET', '/api/sessions')).sessions) } catch { /* keep the old list */ }
  }

  // ---- chats -----------------------------------------------------------------------------------------------------------------
  function newChat() {
    r.ctl?.abort()
    stopPoll()
    setSid(null)
    r.stick = true
    setItems(user() ? [] : fromHistory(r.history))
    setTitle('')
    setEffort(r.me ? defaultEffort(r.me) : 'medium')
  }
  async function openSession(id: number) {
    r.ctl?.abort()
    stopPoll()
    setSid(id)
    let d: any
    try { d = await api('GET', `/api/sessions/${id}`) } catch {
      toast('That chat no longer exists.')
      setSid(null)
      location.hash = '#/'
      return
    }
    const list = replay(d.messages, id)
    r.stick = true
    setItems(list)
    setEffort(d.effort)
    setTitle(d.title || 'Chat')
    if (d.running) {
      const last = list[list.length - 1]
      const t = last?.kind === 'turn' ? last.turn : null
      if (t) t.setStatus('The assistant is still working…', 'sparkle', true)
      startPoll(id)
    }
  }
  function route(first?: boolean) {
    const m = /^\/c\/(\d+)$/.exec(location.hash.replace(/^#/, '') || '/')
    if (m && user()) return void openSession(Number(m[1]))
    if (m) { location.hash = '#/'; return }
    if (first === true || r.sid !== null) newChat()
  }

  function startPoll(id: number) {
    stopPoll()
    r.polling = true
    setBusy(true)
    r.poll = setInterval(async () => {
      try {
        const d = await api('GET', `/api/sessions/${id}`)
        if (d.running) return
        stopPoll()
        if (r.sid === id) await openSession(id)
        void refreshSessions()
      } catch { /* keep trying; the network may be back soon */ }
    }, 2500)
  }
  function stopPoll() {
    if (r.poll) clearInterval(r.poll)
    r.poll = 0
    r.polling = false
    setBusy(false)
  }
  function stop() {
    if (r.polling) return void stopPoll()
    r.ctl?.abort()
  }

  function onSession(id: number, text: string | null) {
    if (r.sid === id) return
    setSid(id)
    history.replaceState(null, '', `#/c/${id}`) // the URL is the state; replaceState does not trigger a route change
    setTitle((text || 'Chat').split('\n')[0]!.slice(0, 60))
  }
  // the model writes a better title a few seconds after the first answer: look for it a few times, then stop
  function watchTitle(id: number) {
    let tries = 0
    const tick = async () => {
      if (++tries > 6 || !user()) return
      let list: SessionRow[] = []
      try { list = (await api<{ sessions: SessionRow[] }>('GET', '/api/sessions')).sessions; setSessions(list) } catch { /* try again */ }
      const s = list.find((x) => x.id === id)
      if (s && r.sid === id) setTitle(chatTitle(s))
      if (!s || s.titleState === 0) setTimeout(tick, tries < 3 ? 4000 : 10000)
    }
    setTimeout(tick, 3000)
  }

  // ---- running the model -----------------------------------------------------------------------------------------------------------
  function newTurn(): TurnModel {
    const t = new TurnModel(true)
    addItem({ id: ++nid, kind: 'turn', turn: t })
    return t
  }

  async function send(text: string, atts: Pending[] = []) {
    if (r.busy) return
    r.stick = true
    if (!user()) { r.history.push({ role: 'user', content: text }); saveHistory(r.history) }
    addItem({ id: ++nid, kind: 'user', text, atts: atts.map(({ kind, name, url, size }) => ({ kind, name, url, size })) })
    await run(text, false, atts)
  }
  function retry(turn: TurnModel) {
    turn.dropErrors()
    if (!user()) setItems((p) => p.filter((i) => !(i.kind === 'turn' && i.turn === turn))) // a visitor's failed attempt is redone from the history; a saved chat keeps what happened
    void run(null, true)
  }
  async function regenerate() {
    if (r.busy) return
    while (r.history.length && r.history[r.history.length - 1]!.role !== 'user') r.history.pop()
    saveHistory(r.history)
    setItems((p) => p.slice(0, -1))
    await run(null, true)
  }

  async function run(text: string | null, isRetry: boolean, atts: Pending[] = []) {
    setBusy(true)
    const turn = newTurn()
    const isNew = user() && r.sid === null
    const ctl = (r.ctl = new AbortController())
    let finished = false
    let failure: any = null
    let lost = false
    try {
      let body: Record<string, unknown>
      if (user()) {
        body = isRetry
          ? { session: r.sid, retry: true, effort: r.effort }
          : { goal: text, session: r.sid ?? undefined, effort: r.effort, attachments: atts.length ? atts.map(({ name, data }) => ({ name, data })) : undefined }
      } else {
        while (r.history.length && r.history[r.history.length - 1]!.hidden) r.history.pop() // a failed attempt is retried without its failure note
        body = { messages: r.history.map(({ role, content }) => ({ role, content })), effort: r.effort }
      }
      const res = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        turn.error({ kind: d.kind, msg: d.error || res.statusText, retryable: d.retryable, rid: d.rid })
        if (res.status === 401 && user()) { await refreshMe(); toast('Your session ended. Sign in again.') }
        return
      }
      for await (const ev of readEvents(res)) {
        if (ev.t === 'session') onSession(ev.id, text)
        else if (ev.t === 'done') finished = true
        else {
          if (ev.t === 'error') failure = ev
          turn.event(ev)
          bump()
        }
      }
      lost = !finished && !failure // the stream ended without done or error: a proxy or the phone dropped it
    } catch (e) {
      if ((e as Error).name === 'AbortError') turn.say(user() ? 'Stopped. The assistant may still finish in the background.' : 'Stopped.')
      else lost = true
    } finally {
      if (lost && user() && r.sid) {
        // the run goes on server side: wait for it instead of showing a failure
        turn.setStatus('Connection lost. The assistant is still working, reconnecting…', 'refresh', false)
        startPoll(r.sid)
      } else {
        if (lost) turn.error({ kind: 'upstream_down', msg: 'The connection was lost before the reply finished.', retryable: true })
        finishRun(turn, finished, failure, ctl.signal.aborted, isNew)
      }
      bump()
    }
  }
  function finishRun(turn: TurnModel, finished: boolean, failure: any, aborted: boolean, isNew: boolean) {
    turn.end()
    turn.finished = finished
    if (!user()) {
      // public: the page owns the history
      const answer = turn.answerText()
      if (answer) r.history.push({ role: 'assistant', content: answer })
      if (failure?.note) r.history.push({ role: 'assistant', content: failure.note, hidden: true })
      saveHistory(r.history)
    } else if (aborted && r.sid) {
      startPoll(r.sid)
      return
    }
    setBusy(false)
    r.ctl = null
    if (user()) {
      void refreshSessions()
      if (isNew && finished && r.sid) watchTitle(r.sid)
    }
  }

  async function setEffortFor(id: string) {
    setEffort(id)
    if (user()) { if (r.sid) api('PATCH', `/api/sessions/${r.sid}`, { effort: id }).catch((e) => toast(e.message)) } // a new chat sends it with its first message
    else store.set(EKEY, id)
  }

  // ---- boot -------------------------------------------------------------------------------------------------------------------
  const F = useRef({ route })
  F.current = { route }
  useEffect(() => {
    setSide(store.get(SKEY) !== '0')
    const q = new URLSearchParams(location.search).get('signin')
    if (q) {
      toast(q === 'denied' ? 'That account is not allowed to use ChocoAI.' : 'Sign-in failed. Try again.')
      history.replaceState(null, '', location.pathname + location.hash)
    }
    void refreshMe().then(() => F.current.route(true))
    const onHash = () => F.current.route()
    const onInstall = (e: Event) => { e.preventDefault(); const ev = e as Event & { prompt: () => Promise<void> }; setInstall({ prompt: ev.prompt.bind(ev) }) }
    addEventListener('hashchange', onHash)
    addEventListener('beforeinstallprompt', onInstall)
    // phones: the keyboard shrinks the visual viewport, not the layout viewport
    const vv = window.visualViewport
    const fit = () => document.documentElement.style.setProperty('--app-h', `${vv!.height}px`)
    if (vv) { vv.addEventListener('resize', fit); fit() }
    return () => { removeEventListener('hashchange', onHash); removeEventListener('beforeinstallprompt', onInstall); vv?.removeEventListener('resize', fit) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { document.title = title ? `${title} – ChocoAI` : 'ChocoAI – your AI assistant' }, [title])

  // ---- render -------------------------------------------------------------------------------------------------------------------
  if (!me) return <div className="bg-background h-dvh" aria-busy="true" />
  const u = me.capabilities.history === 'user'
  const sideVisible = u && wide && side
  const openChat = (id: number) => { setSheet(null); location.hash = `#/c/${id}` }
  const goNew = () => { setSheet(null); if (location.hash === '#/' || !location.hash) newChat(); else location.hash = '#/'; document.getElementById('message')?.focus() }
  const toggleSide = () => { const v = !side; setSide(v); store.set(SKEY, v ? '1' : '0') }
  const chatList = (
    <ChatList
      sessions={sessions}
      sid={sid}
      onOpen={openChat}
      onNew={goNew}
      onRename={async (id, t) => {
        try { const x = await api('PATCH', `/api/sessions/${id}`, { title: t }); setSessions((p) => p.map((s) => (s.id === id ? { ...s, title: x.title, titleState: 2 } : s))); if (r.sid === id) setTitle(x.title) } catch (e) { toast((e as Error).message) }
      }}
      onDelete={async (id) => {
        try { await api('DELETE', `/api/sessions/${id}`) } catch { return void toast('Could not delete that chat.') }
        setSessions((p) => p.filter((s) => s.id !== id))
        if (r.sid === id) location.hash = '#/'
      }}
      extra={me.capabilities.automations ? <Button variant="outline" className="w-full" onClick={() => setSheet('automations')}><RefreshCw /> Automations</Button> : null}
    />
  )
  const chips = SUGGESTIONS.filter((s) => !s.needs || me.capabilities.tools.includes(s.needs))
  const fine = u ? 'Saved to your account. The assistant can make mistakes.' : 'Your chat stays on this device. The assistant can make mistakes.'

  return (
    <div className="flex overflow-hidden" style={{ height: 'var(--app-h, 100dvh)' }}>
      {sideVisible ? <aside className="bg-sidebar flex w-72 shrink-0 flex-col gap-2 border-r p-3" aria-label="Chats">{chatList}</aside> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <AppHeader
          brand="ChocoAI"
          brandIcon={Sparkles}
          home="/"
          items={[]}
          fluid
          end={
            <>
              {u && !sideVisible ? <Button variant="ghost" size="icon" aria-label="New chat" onClick={goNew}><Plus /></Button> : null}
              {u ? <Button variant="ghost" size="icon" aria-label={wide ? (side ? 'Close sidebar' : 'Open sidebar') : 'Chats'} onClick={() => (wide ? toggleSide() : setSheet('chats'))}><Menu /></Button> : null}
              <Button variant="ghost" size="icon" aria-label="Account" onClick={() => setSheet('account')}>
                {me.address ? <span className="bg-primary text-primary-foreground grid size-6 place-items-center rounded-full text-xs font-semibold">{me.address[0]!.toUpperCase()}</span> : <User />}
              </Button>
            </>
          }
        />
        {title ? <p className="text-muted-foreground truncate border-b px-4 py-1 text-center text-xs" data-testid="chat-title">{title}</p> : null}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scroller}
            className="h-full overflow-y-auto"
            onScroll={(e) => {
              const el = e.currentTarget
              r.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 80
              setJump(!r.stick && items.length > 0)
            }}
          >
            <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6" data-testid="messages">
              {items.length === 0 ? (
                <div className="flex flex-col items-center gap-3 py-16 text-center">
                  <BrandMark icon={Sparkles} size="lg" />
                  <h2 className="text-2xl font-semibold tracking-tight">How can I help?</h2>
                  <p className="text-muted-foreground">{u ? 'What are we working on?' : 'Ask anything.'}</p>
                  <div className="flex max-w-xl flex-wrap justify-center gap-2 pt-2">
                    {chips.map((s) => <Button key={s.text} variant="outline" size="sm" className="h-auto py-1.5 whitespace-normal" onClick={() => void send(s.text)}>{s.text}</Button>)}
                  </div>
                </div>
              ) : null}
              {items.map((it) =>
                it.kind === 'user' ? (
                  <div key={it.id} className="flex justify-end">
                    <div className="max-w-[85%] space-y-2 rounded-2xl bg-[color-mix(in_oklab,var(--primary)_14%,var(--card))] px-4 py-2.5 whitespace-pre-wrap">
                      {it.atts.filter((a) => a.kind === 'image').map((a) => <img key={a.name} src={a.url} alt={a.name} className="max-h-60 rounded-lg" />)}
                      {it.atts.some((a) => a.kind === 'file') ? <div className="flex flex-wrap gap-2">{it.atts.filter((a) => a.kind === 'file').map((a) => <AttChip key={a.name} a={a} />)}</div> : null}
                      {it.text}
                    </div>
                  </div>
                ) : (
                  <div key={it.id} className="flex gap-3">
                    <BrandMark icon={Sparkles} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <TurnView turn={it.turn} version={it.turn.version} onRetry={() => retry(it.turn)} onContinue={() => void send('continue')} />
                      {it.turn.finished && it.turn.answerText() ? (
                        <div className="mt-1 flex gap-1">
                          <CopyButton text={it.turn.answerText()} label="Copy reply" />
                          {!u ? <Button variant="ghost" size="icon-sm" aria-label="Regenerate" onClick={() => void regenerate()}><RefreshCw /></Button> : null}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
          {jump ? <Button variant="outline" size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-sm" onClick={() => { r.stick = true; scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' }) }}><ArrowDown /> Latest</Button> : null}
        </div>
        <Composer me={me} busy={busy} effort={effort} onEffort={(id) => void setEffortFor(id)} onSend={(t, a) => void send(t, a)} onStop={stop} fine={fine} />
      </div>

      <Dialog open={sheet === 'chats'} onOpenChange={(o) => !o && setSheet(null)}>
        <DialogContent className="flex max-h-[85dvh] flex-col"><DialogHeader><DialogTitle>Chats</DialogTitle></DialogHeader>{chatList}</DialogContent>
      </Dialog>
      <AutomationsDialog open={sheet === 'automations'} onOpenChange={(o) => !o && setSheet(null)} tz={me.capabilities.timezone || 'UTC'} onOpenChat={openChat} />
      <AccountDialog
        open={sheet === 'account'}
        onOpenChange={(o) => !o && setSheet(null)}
        me={me}
        hasPublicChat={!u && r.history.length > 0}
        install={install}
        onReset={() => { r.history = []; saveHistory([]); setSheet(null); newChat(); toast('Chat reset.') }}
        onSignOut={async () => {
          try { await api('POST', '/api/logout') } catch { /* the server clears the cookie; a failure here changes nothing for the user */ }
          setSheet(null); setSid(null); history.replaceState(null, '', '#/')
          await refreshMe(); newChat()
        }}
      />
    </div>
  )
}
