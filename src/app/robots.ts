import type { MetadataRoute } from 'next'

export const dynamic = 'force-dynamic' // HARNESS_PUBLIC_URL is read at runtime, not baked in at build

export default function robots(): MetadataRoute.Robots {
  const site = (process.env.HARNESS_PUBLIC_URL ?? '').replace(/\/+$/, '')
  return { rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/manage/', '/task'] }, ...(site ? { sitemap: `${site}/sitemap.xml` } : {}) }
}
