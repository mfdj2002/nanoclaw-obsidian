'use strict';
// Nanoclaw Chat — Obsidian plugin with multi-tab parallel sessions.
//
// Talks to nanoclaw's dedicated `obsidian` channel over data/obsidian.sock.
// ONE persistent socket; every message is tagged with a per-tab `threadId`, so
// each tab is its own nanoclaw session → its own container → genuinely parallel,
// with replies routed back per-thread (no cross-talk). Plain JS, no deps,
// desktop-only (needs Node's `net`).

const { Plugin, ItemView, PluginSettingTab, Setting, FuzzySuggestModal, Modal, Notice } = require('obsidian');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

const VIEW_TYPE = 'nanoclaw-chat-view';

const DEFAULT_SETTINGS = {
  socketPath: path.join(os.homedir(), 'cc', 'nanoclaw-v2', 'data', 'obsidian.sock'),
  silenceMs: 2500,
  agentName: 'andy',
  saveChats: true,
  chatsFolder: 'Nanoclaw Chats',
  // Match nanoclaw's container ceiling (30 min). Long research runs are silent on
  // the socket until the final answer, so don't give up early — use Stop to interrupt.
  turnTimeoutMs: 1800000,
  modelScript: path.join(os.homedir(), 'cc', 'nanoclaw-model.sh'),
  keyScript: path.join(os.homedir(), 'cc', 'nanoclaw-v2', 'deployment', 'scripts', 'nanoclaw-deepseek-key.sh'),
  harvestFolder: 'Web Harvest',
};

function fmtElapsed(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// Parse a saved chat .md (frontmatter + "## you" / "## <agent>" turns) back into
// messages. Only `## you` and `## <agentName>` headers are turn boundaries, so a
// reply that happens to contain other markdown headings survives intact.
function parseChatMd(content, agentName) {
  let body = content;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) { const nl = body.indexOf('\n', end + 1); body = nl >= 0 ? body.slice(nl + 1) : ''; }
  }
  const agent = (agentName || 'andy').toLowerCase();
  const msgs = [];
  let role = null, buf = [];
  const flush = () => {
    if (role) {
      let text = buf.join('\n').trim();
      let thinking;
      // Pull a leading "> [!note]- thinking" callout back out into a foldable block.
      if (role === 'agent' && /^>\s*\[!note\]-\s*thinking/i.test(text)) {
        const ls = text.split('\n');
        const body = [];
        let i = 1; // skip the callout header line
        while (i < ls.length && /^>\s?/.test(ls[i])) { body.push(ls[i].replace(/^>\s?/, '')); i++; }
        thinking = body.join('\n').trim() || undefined;
        text = ls.slice(i).join('\n').trim();
      }
      if (text || thinking) msgs.push({ role, text, thinking });
    }
    buf = [];
  };
  for (const line of body.split('\n')) {
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m) {
      const h = m[1].toLowerCase();
      if (h === 'you' || h === agent) { flush(); role = h === 'you' ? 'you' : 'agent'; continue; }
    }
    if (role) buf.push(line);
  }
  flush();
  return msgs;
}

class NanoclawChatPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    await this._autodetectInstall();
    this.threads = new Map();   // threadId -> { id, title, messages:[{role,text,pending}], inFlight, started, acc, t0, ticker, timer }
    this.activeId = null;
    this.views = new Set();
    this.socket = null;
    this.rxbuf = '';
    this.newThread();

    this.registerView(VIEW_TYPE, (leaf) => new NanoclawChatView(leaf, this));
    this.addRibbonIcon('message-circle', 'Nanoclaw chat', () => this.activateView());
    this.addCommand({ id: 'open-nanoclaw-chat', name: 'Open Nanoclaw chat', callback: () => this.activateView() });
    this.addCommand({ id: 'nanoclaw-new-tab', name: 'New chat tab', callback: () => { this.newThread(); this.notify(); } });
    this.addCommand({ id: 'nanoclaw-open-chat', name: 'Open a saved chat', callback: () => this.promptOpenChat() });
    this.addCommand({ id: 'nanoclaw-toggle-model', name: 'Toggle DeepSeek model (fast ⇄ pro)', callback: () => { const isPro = (this.modelLabel || '').includes('pro'); this.setModel(isPro ? 'deepseek-v4-flash' : 'deepseek-v4-pro'); } });
    this.addCommand({ id: 'nanoclaw-connect-mcp', name: 'Connect / manage MCP servers', callback: () => new McpManageModal(this.app, this).open() });
    this.addCommand({ id: 'nanoclaw-list-mcp', name: 'List connected MCP servers', callback: () => this.listMcp() });
    this.addCommand({ id: 'nanoclaw-harvest-tabs', name: 'Harvest open browser tabs → Canvas', callback: () => this.harvestTabs() });
    this.addCommand({ id: 'nanoclaw-rotate-key', name: 'Rotate DeepSeek API key', callback: () => new KeyRotateModal(this.app, this).open() });
    this.modelLabel = this.currentModel();
    this.addSettingTab(new NanoclawSettingTab(this.app, this));
  }

  onunload() { if (this.socket) { try { this.socket.destroy(); } catch (e) { /* noop */ } } }

  // ── threads (tabs) ────────────────────────────────────────────────────────
  newThread(title) {
    const id = 'obs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    this.threads.set(id, { id, title: title || `Chat ${this.threads.size + 1}`, messages: [], inFlight: false, started: false, acc: '', t0: 0, ticker: null, timer: null });
    this.activeId = id;
    return id;
  }
  closeThread(id) {
    const t = this.threads.get(id);
    if (t) { if (t.ticker) clearInterval(t.ticker); if (t.timer) clearTimeout(t.timer); }
    this.threads.delete(id);
    if (this.threads.size === 0) this.newThread();
    if (this.activeId === id) this.activeId = this.threads.keys().next().value;
    this.notify();
  }
  notify() { for (const v of this.views) v.render(); }

  // ── socket transport (one connection, multiplexed by threadId) ────────────
  ensureSocket() {
    if (this.socket && !this.socket.destroyed) return;
    const sp = expandHome(this.settings.socketPath);
    this.rxbuf = '';
    const s = net.connect(sp);
    this.socket = s;
    s.on('error', (e) => {
      const msg = (e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED'))
        ? `daemon not reachable at ${sp} — is the nanoclaw service running?`
        : String((e && e.message) || e);
      this.failInFlight(msg);
    });
    s.on('close', () => { if (this.socket === s) this.socket = null; });
    s.on('data', (c) => this.onData(c));
  }
  onData(chunk) {
    this.rxbuf += chunk.toString('utf8');
    let i;
    while ((i = this.rxbuf.indexOf('\n')) >= 0) {
      const line = this.rxbuf.slice(0, i).trim();
      this.rxbuf = this.rxbuf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch (e) { continue; }
      if (typeof m.text === 'string') this.onReply(m.threadId || null, m.text, m.kind);
    }
  }
  onReply(threadId, text, kind) {
    const t = this.threads.get(threadId);
    if (!t || !t.inFlight) return;   // unknown/closed/finished thread → drop (tagged, so never mis-routed)
    const last = t.messages[t.messages.length - 1];
    if (kind === 'thinking') {
      // Live (chunked) CoT: the provider streams the cumulative thinking-so-far ~1×/sec,
      // so REPLACE the block (each message is the full text so far) and keep it expanded
      // while it streams so you can watch it fill in.
      if (last && last.role === 'agent' && last.pending) { last.thinking = text; last.thinkingOpen = true; }
      if (t.timer) clearTimeout(t.timer);
      t.timer = setTimeout(() => this.finalize(threadId, `no reply within ${Math.round(this.settings.turnTimeoutMs / 60000)} min`), this.settings.turnTimeoutMs);
      this.notify();
      return;
    }
    if (!t.started) { t.started = true; t.acc = ''; if (t.ticker) { clearInterval(t.ticker); t.ticker = null; } }
    t.acc += (t.acc ? '\n' : '') + text;
    if (last && last.role === 'agent' && last.pending) last.text = t.acc;
    if (t.timer) clearTimeout(t.timer);
    t.timer = setTimeout(() => this.finalize(threadId, null), this.settings.silenceMs);
    this.notify();
  }
  finalize(threadId, status) {
    const t = this.threads.get(threadId);
    if (!t || !t.inFlight) return;
    if (t.timer) { clearTimeout(t.timer); t.timer = null; }
    if (t.ticker) { clearInterval(t.ticker); t.ticker = null; }
    t.inFlight = false;
    const last = t.messages[t.messages.length - 1];
    if (last && last.role === 'agent' && last.pending) {
      last.pending = false;
      if (last.thinking) last.thinkingOpen = false;   // tuck the CoT away now that the answer is here
      if (status === 'stopped') last.text = (t.started ? t.acc + '\n\n' : '') + '⏹ stopped (the agent may still finish server-side)';
      else if (status) last.text = (t.started ? t.acc + '\n\n' : '') + '⚠ ' + status;
      else if (!t.started) last.text = '(no reply)';
      else last.text = t.acc;
    }
    if (t.onDone) { const cb = t.onDone; t.onDone = null; try { cb((last && last.role === 'agent') ? last.text : ''); } catch (e) { /* noop */ } }
    if (!t.noSave) this.saveTurn(t, t.pendingUser || '', (last && last.role === 'agent') ? last.text : '', (last && last.thinking) || '');
    this.notify();
  }
  failInFlight(msg) { for (const t of this.threads.values()) if (t.inFlight) this.finalize(t.id, msg); }

  // ── persistence: append each completed turn to a vault .md (Obsidian-rendered) ──
  async ensureChatFile(t) {
    const folder = (this.settings.chatsFolder || '').replace(/\/+$/, '');
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try { await this.app.vault.createFolder(folder); } catch (e) { /* exists / race */ }
    }
    if (!t.filePath) {
      const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(/:/g, '-');
      const slug = ((t.title || 'chat').replace(/[\\/:*?"<>|#^[\]]+/g, '').trim() || 'chat').slice(0, 40);
      const shortId = t.id.slice(-4);
      t.filePath = `${folder ? folder + '/' : ''}${stamp} ${slug} ${shortId}.md`;
      const fm = `---\ncreated: ${new Date().toISOString()}\nthreadId: ${t.id}\nagent: ${this.settings.agentName}\nsource: nanoclaw\n---\n\n# ${t.title || 'Chat'}\n`;
      try { await this.app.vault.create(t.filePath, fm); } catch (e) { /* already exists */ }
    }
    return t.filePath;
  }
  async saveTurn(t, userText, agentText, thinkingText) {
    if (!this.settings.saveChats || !userText) return;
    try {
      const fp = await this.ensureChatFile(t);
      const file = this.app.vault.getAbstractFileByPath(fp);
      const think = thinkingText ? `> [!note]- thinking\n> ${thinkingText.replace(/\n/g, '\n> ')}\n\n` : '';
      if (file) await this.app.vault.append(file, `\n## you\n\n${userText}\n\n## ${this.settings.agentName}\n\n${think}${agentText}\n`);
    } catch (e) { console.error('nanoclaw: saveTurn failed', e); }
  }

  // ── reopen a saved chat .md as a live tab (resumes the same nanoclaw session) ──
  listChatFiles() {
    const folder = (this.settings.chatsFolder || '').replace(/\/+$/, '');
    return this.app.vault.getMarkdownFiles()
      .filter((f) => (folder ? f.path.startsWith(folder + '/') : true))
      .sort((a, b) => ((b.stat && b.stat.mtime) || 0) - ((a.stat && a.stat.mtime) || 0));
  }
  async openChatFile(file) {
    let content = '';
    try { content = await this.app.vault.read(file); } catch (e) { return; }
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter || {};
    // Reuse the original threadId so continuing routes to the SAME nanoclaw session.
    const threadId = (fm.threadId && String(fm.threadId)) || ('obs-file-' + file.path);
    if (this.threads.has(threadId)) { this.activeId = threadId; this.notify(); this.activateView(); return; }
    const msgs = parseChatMd(content, this.settings.agentName);
    const firstYou = msgs.find((m) => m.role === 'you');
    const title = ((firstYou && firstYou.text) || file.basename).slice(0, 24);
    this.threads.set(threadId, { id: threadId, title, messages: msgs, inFlight: false, started: false, acc: '', t0: 0, ticker: null, timer: null, filePath: file.path });
    this.activeId = threadId;
    this.notify();
    this.activateView();
  }
  promptOpenChat() {
    const files = this.listChatFiles();
    if (!files.length) { new Notice(`No saved chats in "${this.settings.chatsFolder}"`); return; }
    new ChatPickerModal(this.app, files, (f) => this.openChatFile(f)).open();
  }

  sendMessage(threadId, raw) {
    const t = this.threads.get(threadId);
    const text = (raw || '').trim();
    if (!t || t.inFlight || !text) return;
    if (t.messages.length === 0) t.title = text.slice(0, 24) + (text.length > 24 ? '…' : '');
    t.pendingUser = text;
    t.messages.push({ role: 'you', text });
    t.messages.push({ role: 'agent', text: '…thinking', pending: true });
    t.inFlight = true; t.started = false; t.acc = ''; t.t0 = Date.now();
    t.ticker = setInterval(() => {
      if (!t.started) {
        const last = t.messages[t.messages.length - 1];
        if (last && last.pending) { last.text = `…working ${fmtElapsed(Date.now() - t.t0)}  (Stop to interrupt)`; this.notify(); }
      }
    }, 1000);
    t.timer = setTimeout(() => this.finalize(threadId, `no reply within ${Math.round(this.settings.turnTimeoutMs / 60000)} min`), this.settings.turnTimeoutMs);
    this.notify();
    try {
      this.ensureSocket();
      this.socket.write(JSON.stringify({ threadId, text }) + '\n');
    } catch (e) { this.finalize(threadId, String((e && e.message) || e)); }
  }
  stop(threadId) { const t = this.threads.get(threadId); if (t && t.inFlight) this.finalize(threadId, 'stopped'); }

  // ── MCP control (connect/list/disconnect over the same socket) ────────────
  // Reuses the in-flight turn machinery so the host's ack renders in the active
  // tab exactly like an agent reply. `payload` is the control object (type + …);
  // `label` is shown as the "you" bubble.
  _runControl(payload, label) {
    let threadId = this.activeId;
    if (!threadId || !this.threads.has(threadId)) threadId = this.newThread();
    const t = this.threads.get(threadId);
    if (t.inFlight) { new Notice('This tab is busy — wait for the current turn to finish.'); return; }
    if (t.messages.length === 0) t.title = label.slice(0, 24);
    t.pendingUser = label;
    t.messages.push({ role: 'you', text: label });
    t.messages.push({ role: 'agent', text: '…', pending: true });
    t.inFlight = true; t.started = false; t.acc = ''; t.t0 = Date.now();
    t.ticker = setInterval(() => {
      if (!t.started) { const last = t.messages[t.messages.length - 1]; if (last && last.pending) { last.text = `…working ${fmtElapsed(Date.now() - t.t0)}`; this.notify(); } }
    }, 1000);
    t.timer = setTimeout(() => this.finalize(threadId, `no reply within ${Math.round(this.settings.turnTimeoutMs / 60000)} min`), this.settings.turnTimeoutMs);
    this.notify();
    this.activateView();
    try {
      this.ensureSocket();
      this.socket.write(JSON.stringify(Object.assign({ threadId }, payload)) + '\n');
    } catch (e) { this.finalize(threadId, String((e && e.message) || e)); }
  }
  connectMcp(server, spec) {
    const payload = spec ? { type: 'connect-mcp', spec } : { type: 'connect-mcp', server };
    this._runControl(payload, `🔌 connect MCP: ${(spec && spec.name) || server}`);
  }
  listMcp() { this._runControl({ type: 'list-mcp' }, '🔌 list MCP servers'); }
  disconnectMcp(server) { if (server) this._runControl({ type: 'disconnect-mcp', server }, `🔌 disconnect MCP: ${server}`); }

  // ── tab harvester: read open Surfing tabs → summarize via nanoclaw → Canvas ──
  // All plugin-side: the harvester runs inside Obsidian's Electron so it reads
  // Surfing's <webview> tabs directly. nanoclaw only does the summaries (over the
  // existing socket). Output: one note per page + an Obsidian .canvas wired by the
  // browsing (referrer) graph.
  async harvestTabs() {
    const tabs = await this._collectSurfingTabs();
    if (!tabs.length) { new Notice('No open Surfing web tabs found — enable Surfing and open some pages first.'); return; }
    new Notice(`Harvesting ${tabs.length} tab(s) — summarizing via nanoclaw…`);
    let summaries = new Array(tabs.length).fill('');
    try {
      const reply = await this._agentRequest(this._harvestPrompt(tabs), `🗂 summarize ${tabs.length} harvested tab(s)`);
      summaries = this._parseSummaries(reply, tabs.length);
    } catch (e) { new Notice('summary step failed: ' + ((e && e.message) || e)); }
    let canvasPath;
    try {
      canvasPath = await this._writeHarvest(tabs, summaries);
      new Notice(`Harvest saved → ${canvasPath}`);
      const f = this.app.vault.getAbstractFileByPath(canvasPath);
      if (f) this.app.workspace.getLeaf(true).openFile(f);
    } catch (e) { new Notice('writing harvest failed: ' + ((e && e.message) || e)); return; }
    // Summaries are saved, so closing the tabs is safe. Ask first.
    if (window.confirm(`Close the ${tabs.length} harvested browser tab(s)?`)) {
      for (const t of tabs) { try { t.leaf.detach(); } catch (e) { /* noop */ } }
    }
  }
  async _collectSurfingTabs() {
    const leaves = this.app.workspace.getLeavesOfType('surfing-view');
    const out = [];
    for (const leaf of leaves) {
      const root = leaf.view && leaf.view.containerEl;
      const wv = root && root.querySelector('webview');
      if (!wv) continue;
      let url = ''; try { url = wv.getURL ? wv.getURL() : (wv.getAttribute('src') || ''); } catch (e) { /* noop */ }
      if (!url || url === 'about:blank' || url.startsWith('app://') || url.startsWith('obsidian://') || url.startsWith('chrome')) continue;
      let title = ''; try { title = wv.getTitle ? wv.getTitle() : ''; } catch (e) { /* noop */ }
      let referrer = '', text = '';
      try { referrer = await wv.executeJavaScript('document.referrer'); } catch (e) { /* noop */ }
      try { text = await wv.executeJavaScript('(document.body?document.body.innerText:"").replace(/\\s+/g," ").slice(0,2500)'); } catch (e) { /* noop */ }
      out.push({ leaf, url, title: (title || url).slice(0, 120), referrer: referrer || '', text: text || '' });
    }
    return out;
  }
  _harvestPrompt(tabs) {
    const blocks = tabs.map((t, i) => `[${i}] 标题: ${t.title}\nURL: ${t.url}\n正文(截断): ${t.text || '(无法读取正文)'}`).join('\n---\n');
    return [
      `你是网页摘要助手。以下是我浏览器里打开的 ${tabs.length} 个网页。`,
      `请为每个网页写一个 2–3 句的中文摘要，抓住核心信息以及为什么值得保存。`,
      `只输出一个严格的 JSON 数组，不要任何额外文字或解释，格式：`,
      `[{"i":0,"summary":"…"},{"i":1,"summary":"…"}]`,
      ``,
      `网页：`,
      blocks,
    ].join('\n');
  }
  _parseSummaries(reply, n) {
    const out = new Array(n).fill('');
    if (!reply) return out;
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
    const body = fence ? fence[1] : reply;
    const s = body.indexOf('['), e = body.lastIndexOf(']');
    let arr = null;
    if (s >= 0 && e > s) { try { arr = JSON.parse(body.slice(s, e + 1)); } catch (err) { /* noop */ } }
    if (Array.isArray(arr)) for (const it of arr) { if (it && typeof it.i === 'number' && it.i >= 0 && it.i < n) out[it.i] = String(it.summary || '').trim(); }
    return out;
  }
  async _writeHarvest(tabs, summaries) {
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16).replace(/:/g, '-');
    const rootFolder = (this.settings.harvestFolder || 'Web Harvest').replace(/\/+$/, '');
    const base = `${rootFolder}/${stamp}`;
    const ensure = async (p) => { if (!this.app.vault.getAbstractFileByPath(p)) { try { await this.app.vault.createFolder(p); } catch (e) { /* exists/race */ } } };
    await ensure(rootFolder); await ensure(base);
    const slug = (x) => ((x || 'page').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim() || 'page').slice(0, 48);
    const notePaths = [];
    for (let i = 0; i < tabs.length; i++) {
      const t = tabs[i], sum = summaries[i] || '(摘要不可用)';
      const fp = `${base}/${String(i + 1).padStart(2, '0')} ${slug(t.title)}.md`;
      const fm = `---\nurl: ${t.url}\ntitle: ${JSON.stringify(t.title)}\nreferrer: ${t.referrer || ''}\ncaptured: ${new Date().toISOString()}\nsource: nanoclaw-harvest\n---\n`;
      const md = `${fm}\n# ${t.title}\n\n[${t.url}](${t.url})\n\n## 摘要\n\n${sum}\n`;
      try { if (!this.app.vault.getAbstractFileByPath(fp)) await this.app.vault.create(fp, md); } catch (e) { /* noop */ }
      notePaths.push(fp);
    }
    // Browsing graph: edges referrer → page (the page that linked here points to it).
    const norm = (u) => (u || '').split('#')[0].replace(/\/+$/, '');
    const byUrl = new Map(); tabs.forEach((t, i) => byUrl.set(norm(t.url), i));
    const parent = tabs.map((t) => { const p = byUrl.get(norm(t.referrer)); return p === undefined ? -1 : p; });
    parent.forEach((p, i) => { if (p === i) parent[i] = -1; });
    const level = tabs.map((_, i) => { let d = 0, p = parent[i], g = 0; while (p >= 0 && g++ < tabs.length) { d++; p = parent[p]; } return d; });
    const perLevel = {}, nodes = [], W = 420, H = 300, GX = 480, GY = 340;
    for (let i = 0; i < tabs.length; i++) {
      const L = level[i]; perLevel[L] = perLevel[L] || 0;
      nodes.push({ id: `n${i}`, type: 'file', file: notePaths[i], x: L * GX, y: perLevel[L] * GY, width: W, height: H });
      perLevel[L]++;
    }
    const edges = [];
    for (let i = 0; i < tabs.length; i++) if (parent[i] >= 0) edges.push({ id: `e${i}`, fromNode: `n${parent[i]}`, toNode: `n${i}`, toEnd: 'arrow' });
    const canvasPath = `${base}/graph.canvas`;
    const json = JSON.stringify({ nodes, edges }, null, 2);
    try { const ex = this.app.vault.getAbstractFileByPath(canvasPath); if (ex) await this.app.vault.modify(ex, json); else await this.app.vault.create(canvasPath, json); } catch (e) { /* noop */ }
    return canvasPath;
  }
  // Send a one-off request to nanoclaw and resolve with the final reply text.
  // Shows progress in a dedicated "🗂 harvest" tab; not saved to a chat note.
  _agentRequest(wireText, label) {
    return new Promise((resolve) => {
      let id = this._harvestThreadId;
      if (!id || !this.threads.has(id)) { id = this.newThread('🗂 harvest'); this._harvestThreadId = id; }
      const t = this.threads.get(id);
      if (t.inFlight) { new Notice('harvest tab is busy — try again in a moment'); resolve(''); return; }
      t.noSave = true; t.title = '🗂 harvest';
      this.activeId = id;
      t.pendingUser = label;
      t.messages.push({ role: 'you', text: label });
      t.messages.push({ role: 'agent', text: '…', pending: true });
      t.inFlight = true; t.started = false; t.acc = ''; t.t0 = Date.now();
      t.onDone = (finalText) => resolve(finalText || '');
      t.ticker = setInterval(() => { if (!t.started) { const last = t.messages[t.messages.length - 1]; if (last && last.pending) { last.text = `…summarizing ${fmtElapsed(Date.now() - t.t0)}`; this.notify(); } } }, 1000);
      t.timer = setTimeout(() => this.finalize(id, `no reply within ${Math.round(this.settings.turnTimeoutMs / 60000)} min`), this.settings.turnTimeoutMs);
      this.notify(); this.activateView();
      try { this.ensureSocket(); this.socket.write(JSON.stringify({ threadId: id, text: wireText }) + '\n'); }
      catch (e) { this.finalize(id, String((e && e.message) || e)); }
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) { leaf = workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    workspace.revealLeaf(leaf);
  }
  // ── model choice (fast V4-Flash vs pro V4-Pro) — shells out to nanoclaw-model.sh ──
  modelEnvPath() { const sp = expandHome(this.settings.socketPath); return path.join(path.dirname(path.dirname(sp)), '.env'); }
  currentModel() {
    try {
      const env = fs.readFileSync(this.modelEnvPath(), 'utf8');
      const m = /^OPENCODE_MODEL=(?:deepseek\/)?(.+?)\s*$/m.exec(env);
      return m ? m[1].trim() : '?';
    } catch (e) { return '?'; }
  }
  setModel(model) {
    const script = expandHome(this.settings.modelScript);
    if (!fs.existsSync(script)) { new Notice(`model script not found: ${script}`); return; }
    new Notice(`switching model → ${model}…`);
    exec(`/bin/bash ${JSON.stringify(script)} ${JSON.stringify(model)}`, (err, _out, errout) => {
      if (err) new Notice('model switch failed: ' + ((errout && errout.trim()) || err.message));
      else { this.modelLabel = this.currentModel(); new Notice('model → ' + this.modelLabel); }
      this.notify();
    });
  }

  // Rotate the DeepSeek API key — shells out to nanoclaw-deepseek-key.sh, which
  // delete-then-creates the api.deepseek.com secret in OneCLI. Running sessions
  // pick it up on their next API call (OneCLI resolves secrets per request) —
  // no container restart. Pass the key via env to keep it out of `ps`.
  rotateKey(key) {
    const script = expandHome(this.settings.keyScript);
    if (!fs.existsSync(script)) { new Notice(`key script not found: ${script}`); return; }
    if (!key || !/^sk-/.test(key)) { new Notice("key must look like 'sk-...'"); return; }
    new Notice('rotating DeepSeek key…');
    exec(`/bin/bash ${JSON.stringify(script)}`, { env: { ...process.env, DEEPSEEK_API_KEY: key } }, (err, _out, errout) => {
      if (err) new Notice('key rotation failed: ' + ((errout && errout.trim()) || err.message));
      else new Notice('✅ DeepSeek key rotated (next API call uses it)');
    });
  }

  // ── autodetect the nanoclaw install on first run ──────────────────────────
  // The defaults (~/cc/nanoclaw-v2/...) don't match a checkout that lives anywhere
  // else (the de-nested provision builds in place at the repo root). If both
  // settings are still at their defaults AND the default paths don't exist, scan
  // $HOME for any */deployment/scripts/nanoclaw-model.sh (a reliable install
  // marker), then set socketPath/modelScript to that install. Pick the one with
  // a live daemon (data/obsidian.sock present) if there are multiple. Never
  // overrides a user-customized path.
  async _autodetectInstall() {
    const d = DEFAULT_SETTINGS;
    const isDefault = this.settings.socketPath === d.socketPath && this.settings.modelScript === d.modelScript;
    if (!isDefault) return;
    if (fs.existsSync(d.socketPath) || fs.existsSync(d.modelScript)) return;
    const home = os.homedir();
    // Prune huge irrelevant trees so the find stays under ~2s.
    const cmd = `find "${home}" -maxdepth 7 \\( -name Library -o -name node_modules -o -name .git -o -name .Trash -o -name .cache \\) -prune -o -path '*/deployment/scripts/nanoclaw-model.sh' -print 2>/dev/null`;
    const out = await new Promise((res) => exec(cmd, { timeout: 15000 }, (_e, so) => res((so || '').split('\n').map((s) => s.trim()).filter(Boolean))));
    if (!out.length) return;
    const ranked = out.map((m) => {
      const inst = path.resolve(m, '../../..');
      const sock = path.join(inst, 'data', 'obsidian.sock');
      return { inst, sock, model: m, hasSock: fs.existsSync(sock) };
    }).sort((a, b) => (b.hasSock ? 1 : 0) - (a.hasSock ? 1 : 0));
    const pick = ranked[0];
    this.settings.socketPath = pick.sock;
    this.settings.modelScript = pick.model;
    this.settings.keyScript = path.join(pick.inst, 'deployment', 'scripts', 'nanoclaw-deepseek-key.sh');
    await this.saveSettings();
    new Notice(`nanoclaw: detected install at ${pick.inst}${pick.hasSock ? '' : ' (daemon not running yet)'}`);
  }

  async saveSettings() { await this.saveData(this.settings); }
}

class NanoclawChatView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Nanoclaw chat'; }
  getIcon() { return 'message-circle'; }

  async onOpen() { this.plugin.views.add(this); this.build(); this.render(); }
  async onClose() { this.plugin.views.delete(this); }

  build() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass('nanoclaw-chat');
    this.tabsEl = root.createDiv({ cls: 'nanoclaw-tabs' });
    this.logEl = root.createDiv({ cls: 'nanoclaw-log' });
    const inp = root.createDiv({ cls: 'nanoclaw-input' });
    this.textarea = inp.createEl('textarea', { attr: { rows: '3', placeholder: 'Message… (Enter to send · Shift+Enter newline)' } });
    this.actionBtn = inp.createEl('button', { text: 'Send' });
    this.actionBtn.onclick = () => {
      const t = this.plugin.threads.get(this.plugin.activeId);
      if (t && t.inFlight) this.plugin.stop(this.plugin.activeId); else this.doSend();
    };
    this.textarea.addEventListener('keydown', (e) => {
      const t = this.plugin.threads.get(this.plugin.activeId);
      if (e.key === 'Enter' && !e.shiftKey && !(t && t.inFlight)) { e.preventDefault(); this.doSend(); }
    });
  }

  doSend() {
    const v = this.textarea.value;
    if (!v.trim()) return;
    this.textarea.value = '';
    this.plugin.sendMessage(this.plugin.activeId, v);
    this.textarea.focus();
  }

  render() {
    if (!this.tabsEl) return;
    // Tab bar
    this.tabsEl.empty();
    for (const t of this.plugin.threads.values()) {
      const tab = this.tabsEl.createDiv({ cls: 'nanoclaw-tab' + (t.id === this.plugin.activeId ? ' active' : '') });
      tab.createSpan({ cls: 'nanoclaw-tab-title', text: t.title + (t.inFlight ? ' …' : '') });
      const x = tab.createSpan({ cls: 'nanoclaw-tab-close', text: '×' });
      x.onclick = (e) => { e.stopPropagation(); this.plugin.closeThread(t.id); };
      tab.onclick = () => { this.plugin.activeId = t.id; this.plugin.notify(); };
    }
    const add = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-newtab', text: '+' });
    add.onclick = () => { this.plugin.newThread(); this.plugin.notify(); };
    const open = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-newtab', text: '⌕' });
    open.setAttr('title', 'Open a saved chat');
    open.onclick = () => this.plugin.promptOpenChat();
    const mdl = this.plugin.modelLabel || '?';
    const isPro = mdl.includes('pro');
    const mb = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-model', text: isPro ? '💎 pro' : '⚡ fast' });
    mb.setAttr('title', `Model: deepseek/${mdl} — click to toggle fast (V4-Flash) / pro (V4-Pro); both thinking-on, global`);
    mb.onclick = () => this.plugin.setModel(isPro ? 'deepseek-v4-flash' : 'deepseek-v4-pro');
    const mcpb = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-model', text: '🔌 mcp' });
    mcpb.setAttr('title', 'Connect / manage MCP servers for the agent');
    mcpb.onclick = () => new McpManageModal(this.app, this.plugin).open();
    const hb = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-model', text: '🗂 harvest' });
    hb.setAttr('title', 'Harvest open Surfing browser tabs → summaries + Canvas graph');
    hb.onclick = () => this.plugin.harvestTabs();

    // Active conversation — keep the user's scroll position unless they're already
    // pinned near the bottom (sticky-bottom) or just switched threads, so streaming
    // a new thinking chunk doesn't yank the view down while they're reading higher up.
    const switched = this._renderedThreadId !== this.plugin.activeId;
    const stick = switched || (this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 80);
    const prevScrollTop = this.logEl.scrollTop;
    this.logEl.empty();
    const t = this.plugin.threads.get(this.plugin.activeId);
    if (t) {
      for (const m of t.messages) {
        const el = this.logEl.createDiv({ cls: `nanoclaw-msg nanoclaw-${m.role}` });
        el.createDiv({ cls: 'nanoclaw-role', text: m.role === 'you' ? 'you' : this.plugin.settings.agentName });
        if (m.thinking) {
          const det = el.createEl('details', { cls: 'nanoclaw-thinking' });
          det.open = !!m.thinkingOpen;   // persist across the per-second re-renders
          det.addEventListener('toggle', () => { m.thinkingOpen = det.open; });
          det.createEl('summary', { text: '🧠 thinking' });
          det.createDiv({ cls: 'nanoclaw-thinking-body', text: m.thinking });
        }
        el.createDiv({ cls: 'nanoclaw-body', text: m.text });
      }
    }
    this.logEl.scrollTop = stick ? this.logEl.scrollHeight : prevScrollTop;
    this._renderedThreadId = this.plugin.activeId;

    // Button reflects active tab's state
    if (this.actionBtn) {
      const busy = !!(t && t.inFlight);
      this.actionBtn.setText(busy ? 'Stop' : 'Send');
      this.actionBtn.toggleClass('nanoclaw-stop', busy);
    }
  }
}

class NanoclawSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Socket path').setDesc('nanoclaw obsidian.sock (multi-session channel).')
      .addText((t) => t.setValue(this.plugin.settings.socketPath).onChange(async (v) => { this.plugin.settings.socketPath = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Agent name').setDesc('Label shown on agent replies.')
      .addText((t) => t.setValue(this.plugin.settings.agentName).onChange(async (v) => { this.plugin.settings.agentName = v.trim() || 'andy'; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Silence timeout (ms)').setDesc('Finalize a reply after this much quiet following the first line.')
      .addText((t) => t.setValue(String(this.plugin.settings.silenceMs)).onChange(async (v) => { this.plugin.settings.silenceMs = parseInt(v, 10) || 2500; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Save chats to .md').setDesc('Append each completed turn to a vault note (persistence + native Obsidian rendering).')
      .addToggle((t) => t.setValue(this.plugin.settings.saveChats).onChange(async (v) => { this.plugin.settings.saveChats = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Chats folder').setDesc('Vault folder for saved chat notes.')
      .addText((t) => t.setValue(this.plugin.settings.chatsFolder).onChange(async (v) => { this.plugin.settings.chatsFolder = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Turn timeout (minutes)').setDesc('Give up on a turn after this long with no reply (Stop interrupts sooner).')
      .addText((t) => t.setValue(String(Math.round(this.plugin.settings.turnTimeoutMs / 60000))).onChange(async (v) => { this.plugin.settings.turnTimeoutMs = (parseInt(v, 10) || 30) * 60000; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Model switch script').setDesc('Path to nanoclaw-model.sh (powers the fast/pro toggle).')
      .addText((t) => t.setValue(this.plugin.settings.modelScript).onChange(async (v) => { this.plugin.settings.modelScript = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Key rotate script').setDesc('Path to nanoclaw-deepseek-key.sh (powers the "Rotate DeepSeek API key" command).')
      .addText((t) => t.setValue(this.plugin.settings.keyScript).onChange(async (v) => { this.plugin.settings.keyScript = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Harvest folder').setDesc('Vault folder for harvested web pages + Canvas graphs.')
      .addText((t) => t.setValue(this.plugin.settings.harvestFolder).onChange(async (v) => { this.plugin.settings.harvestFolder = v.trim() || 'Web Harvest'; await this.plugin.saveSettings(); }));
  }
}

class ChatPickerModal extends FuzzySuggestModal {
  constructor(app, files, onPick) {
    super(app);
    this.files = files;
    this.onPick = onPick;
    this.setPlaceholder('Open a saved Nanoclaw chat…');
  }
  getItems() { return this.files; }
  getItemText(f) { return f.basename; }
  onChooseItem(f) { this.onPick(f); }
}

// Connect / manage MCP servers. Presets are one-click; "custom" lets you wire any
// MCP (command + args + env) — same trust as editing the DB yourself, since this
// only travels over the owner-only local socket. The host acks into the chat tab.
const MCP_PRESETS = [
  ['wallstreetcn', '华尔街见闻 快讯/资讯 (in-tree shim, no key)'],
  ['everything', 'MCP official test server (echo/add/printEnv…)'],
  ['sequential-thinking', 'MCP official sequential-thinking'],
  ['playwright', 'Playwright browser → container /usr/bin/chromium'],
];

class McpManageModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const c = this.contentEl;
    c.createEl('h3', { text: 'Connect / manage MCP servers' });
    c.createEl('p', { cls: 'setting-item-description', text: 'Presets run inside the nanoclaw container. The result is acked into the active chat tab.' });

    for (const [name, desc] of MCP_PRESETS) {
      new Setting(c).setName(name).setDesc(desc)
        .addButton((b) => b.setButtonText('Connect').setCta().onClick(() => { this.plugin.connectMcp(name); this.close(); }));
    }

    c.createEl('hr');
    c.createEl('p', { cls: 'setting-item-description', text: 'Custom MCP (any command available in the container):' });
    const custom = { name: '', command: '', args: '', env: '' };
    new Setting(c).setName('Name').addText((t) => t.setPlaceholder('my-mcp').onChange((v) => (custom.name = v.trim())));
    new Setting(c).setName('Command').addText((t) => t.setPlaceholder('npx').onChange((v) => (custom.command = v.trim())));
    new Setting(c).setName('Args').setDesc('space-separated, e.g. -y some-mcp-package').addText((t) => t.setPlaceholder('-y some-mcp').onChange((v) => (custom.args = v)));
    new Setting(c).setName('Env').setDesc('KEY=VALUE per line (optional)').addTextArea((t) => t.onChange((v) => (custom.env = v)));
    new Setting(c).addButton((b) => b.setButtonText('Connect custom').setCta().onClick(() => {
      if (!custom.name || !custom.command) { new Notice('name and command are required'); return; }
      const args = custom.args.trim() ? custom.args.trim().split(/\s+/) : [];
      const env = {};
      for (const ln of custom.env.split('\n')) { const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(ln); if (m) env[m[1]] = m[2]; }
      this.plugin.connectMcp(null, { name: custom.name, command: custom.command, args, env });
      this.close();
    }));

    c.createEl('hr');
    const manage = { name: '' };
    new Setting(c).setName('List connected')
      .addButton((b) => b.setButtonText('List').onClick(() => { this.plugin.listMcp(); this.close(); }));
    new Setting(c).setName('Disconnect by name').setDesc('Removes it from the agent (next message respawns without it).')
      .addText((t) => t.setPlaceholder('wallstreetcn').onChange((v) => (manage.name = v.trim())))
      .addButton((b) => b.setButtonText('Disconnect').setWarning().onClick(() => { if (!manage.name) { new Notice('enter a name'); return; } this.plugin.disconnectMcp(manage.name); this.close(); }));
  }
  onClose() { this.contentEl.empty(); }
}

class KeyRotateModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    const c = this.contentEl;
    c.createEl('h3', { text: 'Rotate DeepSeek API key' });
    c.createEl('p', { cls: 'setting-item-description',
      text: 'Replaces the key in OneCLI vault. Running sessions pick it up on the next API call — no restart needed.' });
    let key = '';
    new Setting(c).setName('New API key').setDesc('sk-…').addText((t) => {
      t.setPlaceholder('sk-…').onChange((v) => { key = v.trim(); });
      t.inputEl.type = 'password';
    });
    new Setting(c).addButton((b) => b.setButtonText('Rotate').setCta().onClick(() => {
      if (!key) { new Notice('paste a key first'); return; }
      this.plugin.rotateKey(key);
      this.close();
    }));
  }
  onClose() { this.contentEl.empty(); }
}

module.exports = NanoclawChatPlugin;
