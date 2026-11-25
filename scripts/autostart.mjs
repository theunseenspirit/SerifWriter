#!/usr/bin/env node
// macOS: start SerifWriter's local server (with auto-update) in the background
// at login, so the app is always current without running `npm start`.
//   npm run autostart          turn it on (and start it now)
//   npm run autostart -- off   turn it off
// Log: serifwriter.log in this folder.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') { console.error('Autostart is for macOS. Elsewhere, run `npm start` (it auto-updates while running).'); process.exit(1); }

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const label = 'app.serifwriter.server';
const plist = join(homedir(), 'Library/LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const launchctl = (...args) => { try { execFileSync('launchctl', args, { stdio: 'ignore' }); } catch { /* not loaded */ } };

launchctl('bootout', domain, plist);
if (process.argv[2] === 'off') {
  rmSync(plist, { force: true });
  console.log('Autostart is off. Run `npm start` when you want the local server.');
  process.exit(0);
}

mkdirSync(dirname(plist), { recursive: true });
writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(join(root, 'scripts/serve.mjs'))}</string></array>
  <key>WorkingDirectory</key><string>${x(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(dirname(process.execPath))}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${x(join(root, 'serifwriter.log'))}</string>
  <key>StandardErrorPath</key><string>${x(join(root, 'serifwriter.log'))}</string>
</dict></plist>
`);
execFileSync('launchctl', ['bootstrap', domain, plist]);
console.log(`Autostart is on: SerifWriter is served at http://localhost:4173 whenever you're logged in, and updates itself.
If \`npm start\` is still running in a terminal, stop it (Ctrl+C) so the two don't compete for the port.
Turn it off with: npm run autostart -- off`);
