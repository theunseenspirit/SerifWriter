import { defineConfig, type Plugin } from 'vite';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Emits dist/sw.js: a tiny cache-first service worker that precaches every
 * file of the build (hashed JS/CSS chunks plus everything in public/, such as
 * the fonts), so the app opens instantly with no network.
 */
function precacheServiceWorker(): Plugin {
  return {
    name: 'serifwriter-precache-sw',
    apply: 'build',
    enforce: 'post', // after Vite's HTML plugin, so index.html is part of the version hash
    generateBundle(_options, bundle) {
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const full = join(dir, name);
          return statSync(full).isDirectory() ? walk(full) : [full];
        });
      const publicFiles = walk('public')
        .map((f) => relative('public', f).split('\\').join('/'))
        .filter((f) => !f.endsWith('.txt') || f.startsWith('fonts/licenses'));
      const bundled = Object.keys(bundle).filter((f) => !f.endsWith('.map'));
      const files = ['./', ...bundled, ...publicFiles].filter((f) => f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of bundled) {
        const chunk = bundle[f];
        hash.update(f);
        hash.update(chunk.type === 'chunk' ? chunk.code : String(chunk.source));
      }
      for (const f of publicFiles) hash.update(f + statSync(join('public', f)).size);
      const version = hash.digest('hex').slice(0, 12);
      const source = readFileSync('src/sw-template.js', 'utf8')
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [precacheServiceWorker()],
  build: {
    target: ['chrome110', 'safari16.4'],
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 300,
  },
});
