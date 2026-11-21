/** The SSO round trip: /api/auth/sso/start sends the browser to the SSO, /api/auth/sso/callback brings it back with a code. */
import { isAllowed } from '../core/auth.ts'
import * as settings from '../core/settings.ts'
import { siteUrl } from './http.ts'
import { authorizeUrl, completeLogin, FLOW_COOKIE, FLOW_SECONDS, newFlow, openFlow, sameSecret, sealFlow, ssoConfig } from './sso.ts'
import { cookieValue, newSession, SESSION_COOKIE, SESSION_SECONDS, sealSession } from './session.ts'

const secure = (): string => (process.env.NODE_ENV === 'production' ? '; Secure' : '')
/** The address the browser used. NOT `new URL(req.url).origin`: inside the container that is the bind address (http://0.0.0.0:8080). */
const originOf = (req: Request): string => siteUrl(req) || new URL(req.url).origin
const redirect = (to: string, cookies: string[]): Response => {
  const h = new Headers({ Location: to, 'Cache-Control': 'no-store' })
  for (const c of cookies) h.append('Set-Cookie', c)
  return new Response(null, { status: 303, headers: h })
}
const clearFlow = `${FLOW_COOKIE}=; Path=/api/auth/sso; Max-Age=0; HttpOnly; SameSite=Lax${secure()}`

/** Begin the sign-in: remember state/nonce/PKCE verifier in a short-lived encrypted cookie, then go to the SSO. */
export async function ssoStart(req: Request): Promise<Response> {
  const origin = originOf(req)
  const cfg = ssoConfig()
  if (!cfg) return redirect(`${origin}/`, [])
  const { flow, challenge } = newFlow(new URL(req.url).searchParams.get('next') ?? '')
  return redirect(authorizeUrl(cfg, flow, challenge), [`${FLOW_COOKIE}=${await sealFlow(flow)}; Path=/api/auth/sso; Max-Age=${FLOW_SECONDS}; HttpOnly; SameSite=Lax${secure()}`]) // Lax: it must come back on the top-level redirect
}

/** The SSO sends the browser back with ?code&state (or ?error). One generic message for every failure; the reason goes to the log. */
export async function ssoCallback(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const origin = originOf(req)
  const back = (error: string) => redirect(`${origin}/?signin=${error}`, [clearFlow])
  const cfg = ssoConfig()
  if (!cfg) return back('error')
  const flow = await openFlow(cookieValue(req.headers.get('cookie'), FLOW_COOKIE))
  const q = url.searchParams
  if (q.get('error') === 'access_denied') return back('denied')
  if (!flow || !q.get('code') || !q.get('state') || !sameSecret(q.get('state')!, flow.state)) return back('error')
  if (q.get('iss') !== null && q.get('iss') !== cfg.issuer) return back('error') // RFC 9207 mix-up defence
  try {
    const user = await completeLogin(cfg, { code: q.get('code')!, flow })
    if (!isAllowed(user.email, settings.get('allowed_users'))) return back('denied')
    // The session keeps the roles the SSO gave this app; the mode (user or shell) is derived from them on every request.
    const cookie = `${SESSION_COOKIE}=${await sealSession(newSession(user.email, user.roles))}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; SameSite=Lax${secure()}`
    return redirect(`${origin}${flow.next}`, [clearFlow, cookie])
  } catch (err) {
    console.warn('[sso] sign-in refused:', err instanceof Error ? err.message : err)
    return back(err instanceof Error && err.message.includes('no AI role') ? 'denied' : 'error')
  }
}
