'use strict';
// Standalone transport probe — exercises the exact net logic main.js uses,
// against the live nanoclaw cli.sock, without Obsidian. Validates the plugin's
// core before you enable it in the vault.
//   node socket-test.js "your message"
const net = require('net');
const os = require('os');
const path = require('path');

const sockPath = process.env.NANOCLAW_SOCK || path.join(os.homedir(), 'cc', 'nanoclaw-v2', 'data', 'cli.sock');
const text = process.argv.slice(2).join(' ') || 'Reply in 3 words.';

const socket = net.connect(sockPath);
let buf = '';
let saw = false;
let silence = null;
const finish = (err) => {
  if (silence) clearTimeout(silence);
  try { socket.end(); } catch (e) {}
  if (err) { console.error('FAIL:', err); process.exit(1); }
  console.log(saw ? '\nOK — transport works.' : 'FAIL: no reply');
  process.exit(saw ? 0 : 1);
};
const hard = setTimeout(() => finish('timeout: no reply'), 180000);
socket.on('error', (e) => { clearTimeout(hard); finish(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? `daemon not reachable at ${sockPath}` : String(e.message || e)); });
socket.on('connect', () => { console.log(`→ ${sockPath}\nyou> ${text}\nagent>`); socket.write(JSON.stringify({ text }) + '\n'); });
socket.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (typeof m.text === 'string') { saw = true; clearTimeout(hard); process.stdout.write(m.text + '\n'); if (silence) clearTimeout(silence); silence = setTimeout(() => finish(null), 2500); } } catch (e) {}
  }
});
socket.on('close', () => { clearTimeout(hard); finish(saw ? null : 'no reply (closed)'); });
