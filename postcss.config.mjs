/**
 * Tailwind 4 is CSS-first: there is no tailwind.config.js, and the theme lives
 * in src/app/globals.css under @theme. This file is the whole build integration.
 */
const config = { plugins: ['@tailwindcss/postcss'] }
export default config
