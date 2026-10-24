// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Final domain: trycool.app (register it before going live).
export default defineConfig({
  site: 'https://trycool.app',
  vite: {
    plugins: [tailwindcss()],
  },
});
