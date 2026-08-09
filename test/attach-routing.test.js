/**
 * Where an attached file goes, and what reaches the wire.
 *
 * These are the paths that decide whether the agent can open what you handed it
 * and whether you can see it afterwards — and they fail silently when wrong: a
 * bad container path just makes the agent say "file not found", and a file
 * routed to the inbox by mistake still "works" while being invisible to you.
 *
 * Obsidian's own plumbing (drag payloads, the native picker, rendering) is not
 * covered here — only the logic underneath it.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');
const path = require('node:path');

const stub = require('./stub-obsidian.js');
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'obsidian') return stub;
  return origLoad.apply(this, arguments);
};
const NanoclawChatPlugin = require('../main.js');
Module._load = origLoad;

const THREAD = 'obs-test-1';

function makePlugin(settings = {}, vaultFiles = {}) {
  const vault = stub.makeVault(vaultFiles);
  const p = new NanoclawChatPlugin({ vault, metadataCache: { getFirstLinkpathDest: () => null } });
  p.settings = {
    socketPath: '/tmp/fake.sock', agentName: 'andy', outputFolder: 'Andy Files',
    sharedFolder: '', silenceMs: 10, turnTimeoutMs: 1000, saveChats: false, ...settings,
  };
  p.threads = new Map([[THREAD, { id: THREAD, title: 't', messages: [], inFlight: false, started: false, acc: '', attach: [], noSave: true }]]);
  p.views = new Set();
  p.notify = () => {};
  p.saveSettings = async () => {};
  return p;
}

const staged = (p) => p.threads.get(THREAD).attach;

/** Stand-in for a File from the picker / a drop. The exact-size slice matters:
 *  Buffer.from(str).buffer is Node's whole 8KB pool, so handing that over would
 *  silently test 8KB of slack instead of the bytes. */
function fakeFile(name, content, type = '') {
  const b = Buffer.from(content);
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  return { name, size: b.length, type, arrayBuffer: async () => ab };
}

test('a file already in the shared folder is handed over by path, not copied', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent/ping.md': 'hi' });
  const before = p.app.vault._files.size;

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent/ping.md'));

  const a = staged(p)[0];
  assert.equal(a.shared, true, 'should be a live reference');
  assert.equal(a.containerPath, '/workspace/extra/shared-with-agent/ping.md');
  assert.equal(a.data, undefined, 'must not carry bytes');
  assert.equal(p.app.vault._files.size, before, 'must not create a copy');
});

test('a vault file outside the shared folder is copied into attachments/<thread>/', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'Notes/spec.md': 'body' });

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('Notes/spec.md'));

  const a = staged(p)[0];
  assert.equal(a.shared, true);
  assert.equal(a.vaultPath, `shared-with-agent/attachments/${THREAD}/spec.md`);
  assert.equal(a.containerPath, `/workspace/extra/shared-with-agent/attachments/${THREAD}/spec.md`);
  assert.ok(p.app.vault._files.has(a.vaultPath), 'copy should exist in the vault where the user can see it');
});

test('an outside file goes to the shared folder when one is configured', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' });
  await p.attachFromFile(THREAD, fakeFile('report.pdf', '%PDF body', 'application/pdf'));

  const a = staged(p)[0];
  assert.equal(a.shared, true);
  const written = p.app.vault._files.get(`shared-with-agent/attachments/${THREAD}/report.pdf`);
  assert.ok(written, 'copy should land in the shared folder');
  assert.equal(written.toString(), '%PDF body', 'bytes must survive intact');
});

test('with no shared folder, files fall back to base64 for the session inbox', async () => {
  // The setup window: before nanoclaw-mount-vault.sh has run there is no mount,
  // and attachments must still work rather than hard-failing.
  const p = makePlugin({ sharedFolder: '' });
  await p.attachFromFile(THREAD, fakeFile('report.pdf', '%PDF'));

  const a = staged(p)[0];
  assert.ok(!a.shared, 'no shared folder → inbox path');
  assert.equal(Buffer.from(a.data, 'base64').toString(), '%PDF');
});

test('a sibling folder with a matching prefix is not treated as inside the shared root', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent-decoy/x.md': 'x' });

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent-decoy/x.md'));

  // Must be copied in, not referenced in place at a path outside the mount.
  assert.equal(staged(p)[0].vaultPath, `shared-with-agent/attachments/${THREAD}/x.md`);
});

test('shared files travel as a path in the text, never as bytes on the wire', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent/ping.md': 'hi' });
  let sent = null;
  p.ensureSocket = () => { p.socket = { write: (line) => { sent = JSON.parse(line); } }; };

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent/ping.md'));
  p.sendMessage(THREAD, 'summarize this');

  const t = p.threads.get(THREAD);
  clearInterval(t.ticker); clearTimeout(t.timer);

  assert.equal(sent.attachments, undefined, 'a shared file must not be duplicated onto the wire');
  assert.match(sent.text, /summarize this/);
  assert.match(sent.text, /\/workspace\/extra\/shared-with-agent\/ping\.md/, 'agent needs the exact path');
});

test('a mixed send carries bytes only for the non-shared file', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent/ping.md': 'hi' });
  let sent = null;
  p.ensureSocket = () => { p.socket = { write: (line) => { sent = JSON.parse(line); } }; };

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent/ping.md'));
  p.threads.get(THREAD).attach.push({ name: 'x.txt', data: Buffer.from('x').toString('base64'), type: '' });
  p.sendMessage(THREAD, 'both');

  const t = p.threads.get(THREAD);
  clearInterval(t.ticker); clearTimeout(t.timer);

  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].name, 'x.txt');
  assert.match(sent.text, /ping\.md/);
});

test('an attachment-only message is allowed to have no text', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent/ping.md': 'hi' });
  let sent = null;
  p.ensureSocket = () => { p.socket = { write: (line) => { sent = JSON.parse(line); } }; };

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent/ping.md'));
  p.sendMessage(THREAD, '');

  const t = p.threads.get(THREAD);
  clearInterval(t.ticker); clearTimeout(t.timer);
  assert.ok(sent && sent.text.includes('ping.md'), '"look at this" with nothing typed must still send');
});

test('the staging tray is cleared after a send', async () => {
  const p = makePlugin({ sharedFolder: 'shared-with-agent' }, { 'shared-with-agent/ping.md': 'hi' });
  p.ensureSocket = () => { p.socket = { write: () => {} }; };

  await p.attachFromVault(THREAD, p.app.vault.getAbstractFileByPath('shared-with-agent/ping.md'));
  p.sendMessage(THREAD, 'go');

  const t = p.threads.get(THREAD);
  clearInterval(t.ticker); clearTimeout(t.timer);
  assert.equal(t.attach.length, 0, 'else the next message re-sends the same file');
});

test('a file the agent already wrote is not duplicated when it is also sent', async () => {
  const p = makePlugin({ outputFolder: 'Andy Files' }, { 'Andy Files/report.md': 'same bytes' });

  const out = await p.saveAgentFiles([{ name: 'report.md', data: Buffer.from('same bytes').toString('base64') }]);

  assert.deepEqual(out, ['Andy Files/report.md']);
  assert.ok(!p.app.vault._files.has('Andy Files/report-1.md'), 'identical content must not spawn a phantom copy');
});

test('genuinely different content still gets a fresh name rather than overwriting', async () => {
  const p = makePlugin({ outputFolder: 'Andy Files' }, { 'Andy Files/report.md': 'original' });

  const out = await p.saveAgentFiles([{ name: 'report.md', data: Buffer.from('revised').toString('base64') }]);

  assert.deepEqual(out, ['Andy Files/report-1.md']);
  assert.equal(p.app.vault._files.get('Andy Files/report.md').toString(), 'original', 'never clobber the user copy');
});

test('a filename that tries to escape the output folder is flattened', async () => {
  const p = makePlugin({ outputFolder: 'Andy Files' });

  const out = await p.saveAgentFiles([{ name: '../../escape.md', data: Buffer.from('x').toString('base64') }]);

  assert.deepEqual(out, ['Andy Files/escape.md']);
});
