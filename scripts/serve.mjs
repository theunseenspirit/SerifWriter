#!/usr/bin/env node
// Serves SerifWriter at http://localhost:4173 and keeps it up to date: every
// 15 minutes it asks GitHub for a new version; if there is one it pulls,
// rebuilds into dist-next and swaps it in, so the running app never sees a
// half-built copy. The open app then offers to restart (or updates itself the
// next time it opens). Local edits or a failed build leave the current version
// running. Set SERIFWRITER_UPDATE_MINUTES=0 to turn checking off.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const minutes = Number(process.env.SERIFWRITER_UPDATE_MINUTES ?? 15);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const at = (p) => join(root, p);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const log = (m) => console.log(`[${new Date().toLocaleString()}] ${m}`);

function build() {
  run(npm, ['run', 'build', '--', '--outDir', 'dist-next', '--emptyOutDir']);
  rmSync(at('dist-old'), { recursive: true, force: true });
  if (existsSync(at('dist'))) renameSync(at('dist'), at('dist-old'));
  renameSync(at('dist-next'), at('dist'));
  rmSync(at('dist-old'), { recursive: true, force: true });
}

function update() {
  try {
    run('git', ['fetch', '--quiet']);
    if (run('git', ['rev-list', '--count', 'HEAD..@{u}']) === '0') return;
    const before = run('git', ['rev-parse', 'HEAD']);
    run('git', ['pull', '--ff-only', '--quiet']);
    if (run('git', ['diff', '--name-only', before, 'HEAD', '--', 'package-lock.json'])) run(npm, ['install', '--no-audit', '--no-fund']);
    build();
    log(`Updated to ${run('git', ['log', '-1', '--format=%h %s'])}. The app will offer to restart.`);
  } catch (e) {
    log(`Update skipped: ${String(e.stderr || e.message || e).trim().split('\n')[0]}`);
  }
}

if (!existsSync(at('dist/index.html'))) build();
const server = spawn(process.execPath, [at('node_modules/vite/bin/vite.js'), 'preview', '--port', '4173', '--strictPort'], { cwd: root, stdio: 'inherit' });
server.on('exit', (code) => process.exit(code ?? 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.kill(); process.exit(0); });
if (minutes > 0) {
  log(`Checking for updates every ${minutes} minutes.`);
  update();
  setInterval(update, minutes * 60_000);
}
