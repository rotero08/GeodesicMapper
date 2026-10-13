import { defineConfig } from 'vite';

export default defineConfig({
  // A relative base lets the built site run from any folder or sub-path (GitHub Pages included).
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
