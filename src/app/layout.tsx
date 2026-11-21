import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import type { ReactNode } from 'react'
import { MotionProvider } from '@chocorot/design/motion/motion-provider'
import { ThemeProvider } from '@chocorot/design/shell/theme-provider'
import { Toaster } from '@chocorot/design/ui/sonner'
import { TooltipProvider } from '@chocorot/design/ui/tooltip'
import { ServiceWorkerRegister } from '../ui/service-worker-register'
import './globals.css'

const sans = Geist({ subsets: ['latin'], variable: '--font-sans' })
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-mono' })

// HARNESS_PUBLIC_URL is a runtime variable (compose), so the page must render per request, not at build time
export const dynamic = 'force-dynamic'

const TITLE = 'ChocoAI – your AI assistant'
const DESC = 'Chat with ChocoAI for free. Sign in to search the web, plan bigger tasks, read your documents and schedule recurring prompts.'
const OG_ALT = 'ChocoAI logo, a speech bubble with a spark, beside a chat that plans a trip to Kyoto.'

export function generateMetadata(): Metadata {
  const site = (process.env.HARNESS_PUBLIC_URL ?? '').replace(/\/+$/, '')
  return {
  ...(site ? { metadataBase: new URL(site), alternates: { canonical: '/' } } : {}),
  title: TITLE,
  description: DESC,
  applicationName: 'ChocoAI',
  manifest: '/manifest.webmanifest',
  robots: { index: true, follow: true, 'max-image-preview': 'large' },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'ChocoAI' },
  // fixed ?v= so browsers refetch after an icon change: bump it with the icons (see @chocorot/design docs/brand.md)
  icons: { icon: [{ url: '/favicon.ico?v=4', sizes: '48x48' }, { url: '/icons/icon.svg?v=4', type: 'image/svg+xml' }], apple: [{ url: '/icons/apple-touch-icon.png?v=4', sizes: '180x180' }] },
  openGraph: { type: 'website', siteName: 'ChocoAI', title: TITLE, description: 'Chat for free. Sign in for saved chats, web search, documents and scheduled tasks.', locale: 'en_US', images: [{ url: '/icons/og.png?v=4', width: 1200, height: 630, alt: OG_ALT }] },
  twitter: { card: 'summary_large_image', title: TITLE, description: 'Chat for free. Sign in for saved chats, web search, documents and scheduled tasks.', images: [{ url: '/icons/og.png?v=4', alt: OG_ALT }] },
  }
}

// the address bar follows the theme: sRGB of the --background tokens (see @chocorot/design docs/consuming.md)
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#fbfcfd' }, { media: '(prefers-color-scheme: dark)', color: '#040608' }],
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="bg-background text-foreground font-sans antialiased">
        <ThemeProvider>
          <MotionProvider>
            <TooltipProvider>
              {children}
              <Toaster />
              <ServiceWorkerRegister />
            </TooltipProvider>
          </MotionProvider>
        </ThemeProvider>
        <noscript><p className="p-6 text-center">ChocoAI is a chat assistant and needs JavaScript to run.</p></noscript>
      </body>
    </html>
  )
}
