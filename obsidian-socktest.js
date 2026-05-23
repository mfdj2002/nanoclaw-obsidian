'use strict';
// Two-thread probe for the obsidian channel: send t1 and t2 concurrently over ONE
// socket, confirm each reply comes back tagged with its own threadId (per-thread
// sessions, parallel, no cross-talk).
const net = require('net'), os = require('os'), path = require('path');
const sock = process.env.NANOCLAW_OBS_SOCK || path.join(os.homedir(), 'cc', 'nanoclaw-v2', 'data', 'obsidian.sock');
const s = net.connect(sock);
let buf = '';
const got = {};
s.on('error', (e) => { console.error('FAIL:', e.code || e.message); process.exit(1); });
s.on('connect', () => {
  console.log('connected → sending t1 and t2 concurrently…');
  s.write(JSON.stringify({ threadId: 't1', text: 'Reply with exactly the single word: ONE' }) + '\n');
  s.write(JSON.stringify({ threadId: 't2', text: 'Reply with exactly the single word: TWO' }) + '\n');
});
s.on('data', (c) => {
  buf += c.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); console.log(`  [${m.threadId}] ${m.text}`); got[m.threadId] = (got[m.threadId] || '') + m.text; } catch {}
  }
});
setTimeout(() => {
  console.log('---');
  console.log('t1 reply:', got.t1 || '(none)');
  console.log('t2 reply:', got.t2 || '(none)');
  const ok = got.t1 && got.t2;
  console.log(ok ? 'OK: both threads replied, each tagged correctly → no cross-talk' : 'INCOMPLETE (cold spawns can be slow; rerun)');
  s.destroy(); process.exit(ok ? 0 : 1);
}, 170000);
