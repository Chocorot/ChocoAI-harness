import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  // native addon: tracing it into the bundle builds fine and fails only when a route first opens the database
  serverExternalPackages: ['better-sqlite3'],
  // @chocorot/design ships TypeScript source
  transpilePackages: ['@chocorot/design'],
  // chat answers are server-sent events: gzip would hold them back until the buffer fills
  compress: false,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  // the harness is not a site for browsers to frame or sniff
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }, { key: 'X-Frame-Options', value: 'DENY' }, { key: 'Referrer-Policy', value: 'same-origin' }] }]
  },
}

export default nextConfig
