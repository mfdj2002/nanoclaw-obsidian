'use strict';
// Nanoclaw Chat — Obsidian plugin with multi-tab parallel sessions.
//
// Talks to nanoclaw's dedicated `obsidian` channel over data/obsidian.sock.
// ONE persistent socket; every message is tagged with a per-tab `threadId`, so
// each tab is its own nanoclaw session → its own container → genuinely parallel,
// with replies routed back per-thread (no cross-talk). Plain JS, no deps,
// desktop-only (needs Node's `net`).

const { Plugin, ItemView, PluginSettingTab, Setting, FuzzySuggestModal, Notice } = require('obsidian');
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
    this.saveTurn(t, t.pendingUser || '', (last && last.role === 'agent') ? last.text : '', (last && last.thinking) || '');
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

module.exports = NanoclawChatPlugin;
