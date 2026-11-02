import { defineConfig } from 'vite';
// index.html is written as an Artifact body fragment; in dev, wrap it in a real document.
const wrap = {
  name: 'wrap-fragment',
  transformIndexHtml: {
    order: 'pre',
    handler(html) {
      if (html.trimStart().startsWith('<!doctype')) return html;
      return `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>${html}</body></html>`;
    },
  },
};
export default defineConfig({
  base: './',
  plugins: [wrap],
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  build: { target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4000 },
});
