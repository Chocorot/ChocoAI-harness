# Brand, icons, SEO and social previews

Code: `brand/build.py` + `brand/scenes/`, files in `web/icons/`, `web/favicon.ico`, `web/manifest.webmanifest`, `web/robots.txt`, `web/sitemap.xml`, head of `web/index.html`, `harness.py` (`static_file`, `_site`).
Tests: `StaticTests` in `test_harness.py` (types, placeholder, Host safety, metadata complete, real image sizes, manifest files, favicon.ico).

## The mark
A chocolate bar of 2x2 squares: three dark-chocolate squares with a raised edge and a **golden spark** where the fourth would be (the AI). Brand colours: teal `#2fa8b0 -> #16727a` (matches the app's teal), chocolate `#4f2e1d`, gold `#ffc54d`.
It is drawn from numbers in `brand/build.py` (square size, groove, corner radius, spark curve): one geometry, no hand-edited SVG, nothing AI-generated.

| file | use |
|---|---|
| `icons/mark.svg` | the mark alone, transparent, for light backgrounds. **The app's logo tile uses this file** (CSS `.logo`, one source everywhere) |
| `icons/mark-light.svg` | same with light squares, for dark backgrounds |
| `icons/mark-mono.svg` | one colour, for stamps and print |
| `icons/icon.svg` | app icon / favicon (teal tile + mark) |
| `icons/icon-maskable.svg` | full-bleed version with the mark inside the safe zone |
| `favicon.ico` | 16, 32 and 48 px PNGs in one file |
| `icons/icon-192.png`, `icon-512.png`, `apple-touch-icon.png` (180), `icon-maskable-512.png` | PWA and home-screen icons |
| `icons/og.png` (1200x630) | social preview (Open Graph / Twitter large card) |
| `icons/screenshot-wide.png`, `screenshot-narrow.png` | install-dialog screenshots listed in the manifest |

## "Photographs", not generated art
The PNGs are screenshots (Firefox, headless) of real pages: the icons are the SVGs rendered at 1024 px and resized with `sips`; the preview and store screenshots are scenes in `brand/scenes/` built with the app's own CSS and components (`web/js/turn.js`) filled with a sample conversation (a Kyoto trip plan). The wording in the preview only claims what exists: chat for free, sign in for saved chats, web search, documents, scheduled tasks (photos are left out while `vision` is off).
Regenerate everything: `python3 brand/build.py` (or `svg`, `icons`, `scenes`). Needs macOS with Firefox and `sips`; it is a dev tool, not run in CI or in the image. Commit the outputs. After a change to the look of the app, rerun `scenes` so the preview matches.

## Page head (`web/index.html`)
- Title `ChocoAI – your AI assistant` (under 60 characters), description (under 160), `robots` index/follow with large image previews, canonical URL, `color-scheme`, theme colours for light and dark, app and Apple web-app tags.
- Open Graph (`og:type/site_name/title/description/url/locale/image` + type, size, alt) and Twitter (`summary_large_image`, title, description, image, alt).
- JSON-LD `WebApplication` (name, url, description, category, any OS, requires JavaScript). No ratings or prices are claimed.
- Icons: `favicon.ico`, SVG icon, Apple touch icon, manifest.
- A visitor without JavaScript sees the static skeleton and a `noscript` line; search engines that run JavaScript see the app. The app is a single page (`/`), so the sitemap has one URL; chats are private and not indexable.

## The site address is filled in when served
Canonical, `og:url`, `og:image`, `twitter:image`, JSON-LD, `robots.txt` and `sitemap.xml` contain the placeholder `__SITE__`; `harness._site()` replaces it on every response (HTML, txt, xml only):
1. `HARNESS_PUBLIC_URL` if set (recommended in production, e.g. `https://ai.chocorot.net`).
2. Otherwise `http(s)://<Host>`; `https` only when `HARNESS_TRUST_PROXY=1` and `X-Forwarded-Proto: https` (the compose file sets this behind Cloudflare).
3. A `Host` that is not plainly a host name (quotes, spaces, `<`, too long, empty) gives "" (relative URLs), so a crafted header can't put text into the page.
So the same files work on localhost, on a test domain and in production, with no domain written in the repo.

## Manifest (`web/manifest.webmanifest`)
`id`, `name`, `short_name`, `lang`, `categories`, `display: standalone`, icons (any 192, any 512, maskable 512, SVG), `screenshots` (wide and narrow, for the richer install dialog), a "New chat" shortcut. Tests check that every icon and screenshot exists and has the declared pixel size.

## Cache and serving
Images (`.png .svg .ico`) are cached for a day (`Cache-Control: public, max-age=86400`); HTML, CSS, JS, manifest, robots and sitemap are always revalidated. If you change an icon and a browser or app keeps the old one, it is the day-long cache or the service worker (network first for files; the offline copy is only a fallback). Social platforms cache previews on their side: after changing `og.png`, ask each platform's debugger to rescrape the URL.

## Not done / not verified
- I did not test the preview in the platforms' own validators (they need the public URL).
- iOS uses `apple-touch-icon.png` (no transparency, rounded by the OS); Android uses the maskable icon: both only checked as images, not on devices.
- `humans.txt`, `security.txt`, per-page titles (single page) and structured data beyond `WebApplication` are not added.
