import { defineConfig } from 'vite';

export default defineConfig({
  // relative base => built site works when served from a subfolder or opened locally
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 0,
  },
});
