import { App } from '../ui/app'

export default function Page() {
  const site = (process.env.HARNESS_PUBLIC_URL ?? '').replace(/\/+$/, '')
  // no ratings or prices are claimed
  const ld = { '@context': 'https://schema.org', '@type': 'WebApplication', name: 'ChocoAI', ...(site ? { url: `${site}/` } : {}), description: 'A chat assistant. Sign in to search the web, plan bigger tasks, read documents and schedule recurring prompts.', applicationCategory: 'UtilitiesApplication', operatingSystem: 'Any', browserRequirements: 'Requires JavaScript' }
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      <App />
    </>
  )
}
