import type { MetadataRoute } from 'next'

export const dynamic = 'force-dynamic' // HARNESS_PUBLIC_URL is read at runtime, not baked in at build

export default function sitemap(): MetadataRoute.Sitemap {
  const site = (process.env.HARNESS_PUBLIC_URL ?? '').replace(/\/+$/, '')
  return site ? [{ url: `${site}/`, changeFrequency: 'monthly' }] : []
}
