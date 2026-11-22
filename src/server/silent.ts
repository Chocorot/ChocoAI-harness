/**
 * The silent sign-in check: when a visitor opens the page, it asks the SSO once (`prompt=none`) whether this browser is already signed in there,
 * and signs in without a click if so. After a "no" this cookie keeps the page from asking again for a while (and from looping); signing out sets
 * it too, so signing out never signs straight back in. Not a secret and not a session: only "do not ask yet".
 */
export const SILENT_COOKIE = 'choco_ai_silent'
export const SILENT_SECONDS = 600
