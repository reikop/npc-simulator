// Build config for the standalone XMP → NP3 converter page (GitHub Pages).
// Outputs a static site to docs/ so Pages can serve master:/docs directly.
import { defineConfig } from 'vite'

export default defineConfig({
  root: 'converter',
  base: './', // relative asset paths → works at https://<user>.github.io/npc-simulator/
  build: {
    outDir: '../docs',
    emptyOutDir: true
  }
})
