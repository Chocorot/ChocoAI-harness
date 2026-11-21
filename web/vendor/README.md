# Vendored libraries

- `motion.js`: [motion](https://motion.dev) 11.18.2 (MIT, vanilla build of the Framer Motion engine), UMD file `dist/motion.js` from the npm package, exposing the global `Motion` (we use `animate`, `spring`, `stagger`).
  SHA-256 `88f37284fd54d7162af1a7c02b1548430f0e4b8a4fe578f39b90220138d91e14`. Copied unmodified. To update: download the same file from the new version, replace it, update this hash and test the page.

- `../tokens.css` (lives in `web/`, not here): the shared Choco design tokens, vendored from `@chocorot/design` `plain/tokens.css` v0.1.0 (generated file, copied unmodified). SHA-256 `a870031212968f0f90734da4a8a3005e908649ca70893175288583fdf6c874ed`. To update: `npm run build:plain` in ChocoHost-Design, copy `plain/tokens.css` over `web/tokens.css`, update this hash, run `python3 -m unittest` and `node --test web/test/*.test.mjs`, then re-run `python3 brand/build.py scenes`.
