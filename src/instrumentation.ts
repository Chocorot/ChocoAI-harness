/** Runs once when the server starts: begins the automations scheduler (the one place that must outlive any request). */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { shared } = await import('./server/state.ts')
    shared().scheduler.start()
  }
}
