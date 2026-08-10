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
  // Empty means "not located yet" — filled in by _autodetectInstall. Shipping a
  // guessed path is worse than shipping none: an install directory can be named
  // anything, and a wrong-but-plausible default produces "daemon not reachable
  // at <path>" on a perfectly healthy install, which reads as a broken daemon
  // rather than a bad setting.
  socketPath: '',
  silenceMs: 2500,
  agentName: 'andy',
  saveChats: true,
  chatsFolder: 'Nanoclaw Chats',
  // Match nanoclaw's container ceiling (30 min). Long research runs are silent on
  // the socket until the final answer, so don't give up early — use Stop to interrupt.
  turnTimeoutMs: 1800000,
  modelScript: '',
  keyScript: '',
  harvestFolder: 'Web Harvest',
  // Where files the agent sends back are written. The agent never learns this
  // path — it calls send_file and the plugin decides where it lands — which is
  // what keeps agent-authored documents findable regardless of what the
  // container has mounted.
  outputFolder: 'Andy Files',
  // Vault-relative folder that is ALSO mounted into the agent (set up by
  // nanoclaw-mount-vault.sh, which gives it the same name on both sides). When
  // set, attachments go here instead of being base64'd into the agent's private
  // session inbox: one copy, visible to you, editable by both, and yours to
  // delete. Blank falls back to the inbox — which is what the first minutes of
  // an install look like, before the mount exists.
  sharedFolder: '',
  // Models offered by the picker, as `vendor/model`. The vendor prefix is what
  // lets nanoclaw route to a different API, so keep it — a bare name is
  // interpreted as "the vendor already configured".
  models: [
    'deepseek/deepseek-v4-pro',
    'deepseek/deepseek-v4-flash',
    'deepseek/deepseek-chat',
    'moonshotai/kimi-k3',
  ],
};

// Guard against a stray drag-and-drop of something enormous; the whole file is
// base64'd into one socket line, and the daemon caps its side at 32MB too.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;

function fmtElapsed(ms) { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }

/** Filename → something safe to create in a vault. Strips path separators and
 *  the characters Obsidian rejects, and refuses a leading dot. */
function sanitizeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[:*?"<>|#^[\]]+/g, '_').replace(/^\.+/, '').trim();
  return clean || 'file';
}

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
    this.addCommand({ id: 'nanoclaw-switch-model', name: 'Switch model / vendor', callback: () => new ModelPickerModal(this.app, this).open() });
    this.addCommand({ id: 'nanoclaw-connect-mcp', name: 'Connect / manage MCP servers', callback: () => new McpManageModal(this.app, this).open() });
    this.addCommand({ id: 'nanoclaw-list-mcp', name: 'List connected MCP servers', callback: () => this.listMcp() });
    this.addCommand({ id: 'nanoclaw-harvest-tabs', name: 'Harvest open browser tabs → Canvas', callback: () => this.harvestTabs() });
    this.addCommand({ id: 'nanoclaw-rotate-key', name: 'Rotate DeepSeek API key', callback: () => new KeyRotateModal(this.app, this).open() });
    this.modelLabel = this.currentModel();
    this.addSettingTab(new NanoclawSettingTab(this.app, this));
  }

  onunload() { this.resetSocket(); }

  /** Drop the current connection; the next send reconnects using current settings. */
  resetSocket() {
    if (this.socket) { try { this.socket.destroy(); } catch (e) { /* noop */ } }
    this.socket = null;
    this.rxbuf = '';
  }

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
    const sp = expandHome(this.settings.socketPath || '');
    if (!sp) {
      // Nothing located yet. Kick off a scan, but fail this turn honestly rather
      // than connecting to '' and reporting a cryptic errno.
      this._autodetectInstall().catch(() => {});
      throw new Error('no nanoclaw install found yet — Settings → Nanoclaw Chat → Find my install');
    }
    this.rxbuf = '';
    const s = net.connect(sp);
    this.socket = s;
    s.on('error', (e) => {
      const unreachable = e && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED');
      const msg = unreachable
        ? `daemon not reachable at ${sp} — is the nanoclaw service running? (checking for a moved install…)`
        : String((e && e.message) || e);
      this.failInFlight(msg);
      // The path is as likely to be wrong as the daemon is to be down — the
      // default guesses an install directory name. Re-scan rather than leaving
      // the user staring at a path that will never exist. Throttled so a flapping
      // daemon doesn't trigger a filesystem scan per reconnect.
      if (unreachable && Date.now() - (this._lastDetect || 0) > 60000) {
        this._lastDetect = Date.now();
        this._autodetectInstall().catch(() => {});
      }
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
      const hasFiles = Array.isArray(m.files) && m.files.length > 0;
      // A send_file row can carry files with no covering text; don't render an
      // empty bubble for it.
      if (typeof m.text === 'string' && (m.text.length > 0 || !hasFiles)) this.onReply(m.threadId || null, m.text, m.kind);
      if (hasFiles) void this.receiveAgentFiles(m.threadId || null, m.files);
    }
  }

  // ── files the agent sends back (send_file → vault) ────────────────────────
  // The agent's filesystem is not the vault, so a path it mentions is useless to
  // the user. Instead it hands over bytes and we write them into the vault and
  // link them — the link is clickable, which is the whole point.
  async receiveAgentFiles(threadId, files) {
    let paths = [];
    try { paths = await this.saveAgentFiles(files); } catch (e) { new Notice('nanoclaw: writing agent file failed: ' + ((e && e.message) || e)); return; }
    if (!paths.length) return;
    const line = paths.map((p) => `📄 [[${p}]]`).join('\n');
    const t = this.threads.get(threadId);
    if (!t) { new Notice(`${this.settings.agentName} saved ${paths.length} file(s) → ${paths[0]}`); return; }
    // Vault writes are async, so the turn may already have finalized by the time
    // we get here — in that case append a fresh message instead of losing it.
    if (t.inFlight) this.onReply(threadId, line, 'final');
    else { t.messages.push({ role: 'agent', text: line }); this.notify(); }
  }

  async saveAgentFiles(files) {
    const folder = this.toVaultRelative(this.settings.outputFolder);
    if (folder) await this.ensureFolder(folder);
    const out = [];
    for (const f of files) {
      const safe = sanitizeFilename(f && f.name);
      const buf = Buffer.from(String((f && f.data) || ''), 'base64');
      // If the agent wrote the file into the shared folder AND sent it, the
      // bytes already at the target are the same bytes — suffixing would leave
      // a spurious `report-1.md` beside the real one. Identical content is a
      // no-op; only genuinely different content earns a new name.
      const direct = (folder ? folder + '/' : '') + safe;
      const existing = this.app.vault.getAbstractFileByPath(direct);
      if (existing) {
        try {
          const cur = Buffer.from(await this.app.vault.readBinary(existing));
          if (cur.equals(buf)) { out.push(direct); continue; }
        } catch (e) { /* unreadable — fall through and write a new name */ }
      }
      const target = this.uniqueVaultPath(folder, safe);
      await this.app.vault.createBinary(target, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      out.push(target);
    }
    return out;
  }

  // Create every missing segment: `createFolder` does not make parents.
  async ensureFolder(folder) {
    const parts = folder.split('/').filter(Boolean);
    let sofar = '';
    for (const p of parts) {
      sofar = sofar ? `${sofar}/${p}` : p;
      if (!this.app.vault.getAbstractFileByPath(sofar)) {
        try { await this.app.vault.createFolder(sofar); } catch (e) { /* exists / race */ }
      }
    }
  }

  // Never overwrite: a second "report.md" becomes "report-1.md".
  uniqueVaultPath(folder, filename) {
    const dir = folder ? folder + '/' : '';
    if (!this.app.vault.getAbstractFileByPath(dir + filename)) return dir + filename;
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 1; i < 1000; i++) {
      const cand = `${dir}${stem}-${i}${ext}`;
      if (!this.app.vault.getAbstractFileByPath(cand)) return cand;
    }
    return `${dir}${stem}-${Date.now()}${ext}`;
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
    if (!t || t.inFlight) return;
    const staged = t.attach || [];
    // Files living in the shared folder travel as a PATH the agent opens; only
    // the fallback (no shared folder) ships bytes through the session inbox.
    const shared = staged.filter((a) => a.shared);
    const attachments = staged.filter((a) => !a.shared);
    // "Have a look at this" with nothing typed is a legitimate message.
    if (!text && !staged.length) return;
    const label = text || staged[0].name;
    if (t.messages.length === 0) t.title = label.slice(0, 24) + (label.length > 24 ? '…' : '');
    // Note attachments in the persisted turn too, so the saved chat note doesn't
    // read as a question about a document that appears out of nowhere. Anything
    // that lives in the vault is written as a full vault-relative wikilink, so
    // it's clickable from the saved note. A file that went to the session inbox
    // has no vault path to link to, so it stays a bare name.
    const attachNote = staged.length
      ? '\n\nattached: ' + staged.map((a) => (a.vaultPath ? `[[${a.vaultPath}]]` : a.name)).join(', ')
      : '';
    t.pendingUser = text + attachNote;
    t.messages.push({ role: 'you', text, files: staged.map((a) => a.name) });
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
      // Mirror the wording the agent already sees for inbox attachments, so a
      // shared-folder file reads the same way in the prompt — name plus the exact
      // path to open. Nothing on the wire changes; this is just message text.
      const refs = shared.map((a) => `[file: ${a.name} — open it at ${a.containerPath}]`).join('\n');
      const payload = { threadId, text: refs ? (text ? text + '\n\n' + refs : refs) : text };
      if (attachments.length) payload.attachments = attachments.map((a) => ({ name: a.name, data: a.data, type: a.type }));
      this.socket.write(JSON.stringify(payload) + '\n');
      t.attach = [];
    } catch (e) { this.finalize(threadId, String((e && e.message) || e)); }
  }
  stop(threadId) { const t = this.threads.get(threadId); if (t && t.inFlight) this.finalize(threadId, 'stopped'); }

  /** Absolute path of the vault on disk, or '' if unavailable. */
  vaultBasePath() {
    try {
      const a = this.app.vault.adapter;
      return String((a && (a.basePath || (a.getBasePath && a.getBasePath()))) || '').replace(/\/+$/, '');
    } catch (e) { return ''; }
  }

  /**
   * Folder settings are vault-relative, because that is what Obsidian's own
   * file paths are. But the neighbouring socket/script settings are absolute
   * host paths, so reaching for an absolute path here is a natural mistake —
   * and one that fails silently, since an absolute value simply never matches
   * and every attachment quietly takes the inbox fallback. Accept both.
   */
  toVaultRelative(p) {
    let v = String(p || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    const base = this.vaultBasePath();
    if (base && (v === base || v.startsWith(base + '/'))) v = v.slice(base.length);
    return v.replace(/^\/+/, '');
  }

  /** Container path of the shared folder. mount-vault.sh mounts <vault>/<name>
   *  at /workspace/extra/<name>, same leaf both sides, so this is derivable. */
  sharedContainerRoot() {
    const f = this.toVaultRelative(this.settings.sharedFolder);
    return f ? '/workspace/extra/' + f.split('/').pop() : null;
  }
  /** Vault path → the path the agent opens, or null if outside the shared folder. */
  containerPathFor(vaultPath) {
    const f = this.toVaultRelative(this.settings.sharedFolder);
    const root = this.sharedContainerRoot();
    if (!f || !root) return null;
    if (vaultPath !== f && !vaultPath.startsWith(f + '/')) return null;
    return root + vaultPath.slice(f.length);
  }

  // ── attachments the user hands to the agent ───────────────────────────────
  // Anything readable becomes base64 on the wire; the daemon writes it into the
  // session inbox and tells the agent the path. Whether the agent can make sense
  // of a given format is up to its tooling — see README.
  attachTo(threadId, att) {
    const t = this.threads.get(threadId);
    if (!t) return;
    if (!t.attach) t.attach = [];
    t.attach.push(att);
    this.notify();
  }
  dropAttachment(threadId, i) {
    const t = this.threads.get(threadId);
    if (!t || !t.attach) return;
    t.attach.splice(i, 1);
    this.notify();
  }

  /** Read an OS-level File (picker or drag-drop) into an attachment. */
  async attachFromFile(threadId, file) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      new Notice(`${file.name} is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
      return;
    }
    const buf = Buffer.from(await file.arrayBuffer());
    if (await this._stageInShared(threadId, file.name, buf)) return;
    this.attachTo(threadId, { name: file.name, data: buf.toString('base64'), type: file.type || '' });
  }

  /** Read a file already inside the vault (internal drag, or a wikilink). */
  async attachFromVault(threadId, tfile) {
    // Already inside the shared folder → hand over the PATH, not the bytes. No
    // copy at all, so edits flow both ways and there is nothing to diverge.
    const inPlace = this.containerPathFor(tfile.path);
    if (inPlace) {
      this.attachTo(threadId, { name: tfile.name, shared: true, vaultPath: tfile.path, containerPath: inPlace });
      return;
    }
    const ab = await this.app.vault.readBinary(tfile);
    if (ab.byteLength > MAX_ATTACHMENT_BYTES) {
      new Notice(`${tfile.name} is too large (max ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB)`);
      return;
    }
    if (await this._stageInShared(threadId, tfile.name, Buffer.from(ab))) return;
    this.attachTo(threadId, { name: tfile.name, data: Buffer.from(ab).toString('base64'), type: '' });
  }

  /**
   * Copy bytes into <shared>/attachments/<thread>/ and attach a reference.
   * Returns false when no shared folder is configured, so callers fall back to
   * the base64/inbox path.
   */
  async _stageInShared(threadId, name, buf) {
    const f = this.toVaultRelative(this.settings.sharedFolder);
    if (!f) return false;
    const dir = `${f}/attachments/${threadId}`;
    try {
      await this.ensureFolder(dir);
      const target = this.uniqueVaultPath(dir, sanitizeFilename(name));
      await this.app.vault.createBinary(target, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      const cp = this.containerPathFor(target);
      if (!cp) return false;
      this.attachTo(threadId, { name, shared: true, vaultPath: target, containerPath: cp });
      return true;
    } catch (e) {
      new Notice(`couldn't stage ${name} in ${f}: ${(e && e.message) || e}`);
      return false;
    }
  }

  /**
   * Obsidian's internal drags carry a wikilink or vault-relative path as text,
   * not a File. Resolve it so dragging a note out of the file explorer works.
   */
  resolveVaultRef(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    const link = /^!?\[\[([^\]|#]+)/.exec(s);
    const ref = (link ? link[1] : s).trim();
    const direct = this.app.vault.getAbstractFileByPath(ref);
    if (direct && direct.extension) return direct;
    const resolved = this.app.metadataCache.getFirstLinkpathDest(ref, '');
    return resolved || null;
  }

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
  // <install>/data/obsidian.sock → <install>/.env. Null when the install hasn't
  // been located, so callers surface "not found" instead of reading '/.env'.
  modelEnvPath() {
    const sp = expandHome(this.settings.socketPath || '');
    return sp ? path.join(path.dirname(path.dirname(sp)), '.env') : null;
  }
  currentModel() {
    try {
      const envPath = this.modelEnvPath();
      if (!envPath) return '?';
      const env = fs.readFileSync(envPath, 'utf8');
      const m = /^OPENCODE_MODEL=(.+?)\s*$/m.exec(env);
      return m ? m[1].trim() : '?';
    } catch (e) { return '?'; }
  }
  /** Short label for the tab strip — the model name without its vendor. */
  modelShortLabel() {
    const full = this.modelLabel || '?';
    const i = full.indexOf('/');
    return i > 0 ? full.slice(i + 1) : full;
  }
  setModel(model) {
    const script = expandHome(this.settings.modelScript || '');
    if (!script) { new Notice('nanoclaw install not located — Settings → Find my install'); return; }
    if (!fs.existsSync(script)) { new Notice(`model script not found: ${script}`); return; }
    new Notice(`switching model → ${model}…`);
    exec(`/bin/bash ${JSON.stringify(script)} ${JSON.stringify(model)}`, (err, out, errout) => {
      if (err) { new Notice('model switch failed: ' + ((errout && errout.trim()) || err.message)); this.notify(); return; }
      // The script now stores the model per agent group, so .env no longer
      // reflects it — trust what we just set rather than re-reading .env. A
      // vendor-switch warning goes to stdout; surface it, since the switch will
      // fail at the first API call if the key isn't in the vault.
      this.modelLabel = model.includes('/') ? model : this.modelLabel.replace(/^([^/]+\/).*$/, `$1${model}`);
      new Notice('model → ' + this.modelLabel);
      const warn = String(out || '').split('\n').find((l) => l.includes('⚠'));
      if (warn) new Notice(warn.trim(), 10000);
      this.notify();
    });
  }

  // Rotate the DeepSeek API key — shells out to nanoclaw-deepseek-key.sh, which
  // delete-then-creates the api.deepseek.com secret in OneCLI. Running sessions
  // pick it up on their next API call (OneCLI resolves secrets per request) —
  // no container restart. Pass the key via env to keep it out of `ps`.
  rotateKey(key) {
    const script = expandHome(this.settings.keyScript || '');
    if (!script) { new Notice('nanoclaw install not located — Settings → Find my install'); return; }
    if (!fs.existsSync(script)) { new Notice(`key script not found: ${script}`); return; }
    if (!key || !/^sk-/.test(key)) { new Notice("key must look like 'sk-...'"); return; }
    new Notice('rotating DeepSeek key…');
    exec(`/bin/bash ${JSON.stringify(script)}`, { env: { ...process.env, DEEPSEEK_API_KEY: key } }, (err, _out, errout) => {
      if (err) new Notice('key rotation failed: ' + ((errout && errout.trim()) || err.message));
      else new Notice('✅ DeepSeek key rotated (next API call uses it)');
    });
  }

  // ── locate the nanoclaw install ───────────────────────────────────────────
  // The defaults are a guess: an install directory can be named anything, and
  // `nanoclaw-v2` is just one person's choice. Rather than trusting the guess,
  // scan $HOME for */deployment/scripts/nanoclaw-model.sh (a reliable install
  // marker) and adopt the install that actually has a live daemon socket.
  //
  // The guard is "the configured socket does not exist", not "settings are
  // untouched" — that also repairs a customised path after the install moves or
  // is renamed, and it can never clobber a working config, because a working
  // config means the socket is there.
  //
  // Auto-adoption additionally requires the candidate to have a LIVE socket, so
  // a stopped daemon on install A never silently repoints the plugin at
  // install B. `force` (the settings button) reports whatever it finds.
  async _autodetectInstall({ force = false } = {}) {
    const configured = expandHome(this.settings.socketPath || '');
    if (!force && configured && fs.existsSync(configured)) return false;

    const home = os.homedir();
    // Prune huge irrelevant trees so the find stays under ~2s.
    const cmd = `find "${home}" -maxdepth 7 \\( -name Library -o -name node_modules -o -name .git -o -name .Trash -o -name .cache \\) -prune -o -path '*/deployment/scripts/nanoclaw-model.sh' -print 2>/dev/null`;
    const out = await new Promise((res) => exec(cmd, { timeout: 15000 }, (_e, so) => res((so || '').split('\n').map((x) => x.trim()).filter(Boolean))));
    if (!out.length) {
      if (force) new Notice('nanoclaw: no install found under your home folder — set the socket path manually.');
      return false;
    }

    const ranked = out.map((m) => {
      const inst = path.resolve(m, '../../..');
      const sock = path.join(inst, 'data', 'obsidian.sock');
      return { inst, sock, model: m, hasSock: fs.existsSync(sock) };
    }).sort((a, b) => (b.hasSock ? 1 : 0) - (a.hasSock ? 1 : 0));

    const pick = ranked[0];
    // Adopt without a live socket only when there is nothing configured yet —
    // then there is no working setting to lose. Once a path IS set, require a
    // live socket, so a stopped daemon on install A can't repoint at install B.
    if (!pick.hasSock && !force && configured) return false;
    if (pick.sock === configured) {
      if (force) new Notice(`nanoclaw: already pointed at ${pick.inst}${pick.hasSock ? '' : ' (daemon not running)'}`);
      return false;
    }

    this.settings.socketPath = pick.sock;
    this.settings.modelScript = pick.model;
    this.settings.keyScript = path.join(pick.inst, 'deployment', 'scripts', 'nanoclaw-deepseek-key.sh');
    await this.saveSettings();
    this.modelLabel = this.currentModel();
    new Notice(`nanoclaw: found install at ${pick.inst}${pick.hasSock ? '' : ' (daemon not running yet)'}`);
    this.notify();
    return true;
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
    this.trayEl = inp.createDiv({ cls: 'nanoclaw-tray' });
    const row = inp.createDiv({ cls: 'nanoclaw-input-row' });
    this.textarea = row.createEl('textarea', { attr: { rows: '3', placeholder: 'Message… (Enter to send · Shift+Enter newline · drop files to attach)' } });
    const clip = row.createEl('button', { text: '📎', attr: { title: 'Attach files for the agent to read' } });
    this.actionBtn = row.createEl('button', { text: 'Send' });
    this.actionBtn.onclick = () => {
      const t = this.plugin.threads.get(this.plugin.activeId);
      if (t && t.inFlight) this.plugin.stop(this.plugin.activeId); else this.doSend();
    };
    this.textarea.addEventListener('keydown', (e) => {
      const t = this.plugin.threads.get(this.plugin.activeId);
      if (e.key === 'Enter' && !e.shiftKey && !(t && t.inFlight)) { e.preventDefault(); this.doSend(); }
    });

    // Hidden native picker — the only way to reach files outside the vault,
    // which is the common case for a PDF someone was just sent.
    const picker = inp.createEl('input', { attr: { type: 'file', multiple: 'true' } });
    picker.style.display = 'none';
    picker.addEventListener('change', async () => {
      for (const f of Array.from(picker.files || [])) await this.plugin.attachFromFile(this.plugin.activeId, f);
      picker.value = '';
    });
    clip.onclick = () => picker.click();

    // Drop anywhere over the panel. Obsidian's own drags hand over a wikilink
    // rather than a File, so handle both.
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    root.addEventListener('dragover', (e) => { stop(e); root.addClass('nanoclaw-dragging'); });
    root.addEventListener('dragleave', () => root.removeClass('nanoclaw-dragging'));
    root.addEventListener('drop', async (e) => {
      stop(e);
      root.removeClass('nanoclaw-dragging');
      const dt = e.dataTransfer;
      if (!dt) return;
      const osFiles = Array.from(dt.files || []);
      if (osFiles.length) {
        for (const f of osFiles) await this.plugin.attachFromFile(this.plugin.activeId, f);
        return;
      }
      const ref = this.plugin.resolveVaultRef(dt.getData('text/plain'));
      if (ref) await this.plugin.attachFromVault(this.plugin.activeId, ref);
      else new Notice("Couldn't read that — try the 📎 button.");
    });
  }

  doSend() {
    const v = this.textarea.value;
    const t = this.plugin.threads.get(this.plugin.activeId);
    if (!v.trim() && !(t && t.attach && t.attach.length)) return;
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
    const mb = this.tabsEl.createDiv({ cls: 'nanoclaw-tab nanoclaw-model', text: '🧠 ' + this.plugin.modelShortLabel() });
    mb.setAttr('title', `Model: ${mdl} — click to switch. Edit the list in settings.`);
    mb.onclick = () => new ModelPickerModal(this.app, this.plugin).open();
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
        if (m.text) el.createDiv({ cls: 'nanoclaw-body', text: m.text });
        if (Array.isArray(m.files) && m.files.length) {
          const fl = el.createDiv({ cls: 'nanoclaw-files' });
          for (const name of m.files) fl.createSpan({ cls: 'nanoclaw-chip', text: '📎 ' + name });
        }
      }
    }
    this.logEl.scrollTop = stick ? this.logEl.scrollHeight : prevScrollTop;
    this._renderedThreadId = this.plugin.activeId;

    // Staged attachments for the active tab
    this.trayEl.empty();
    const staged = (t && t.attach) || [];
    this.trayEl.toggleClass('nanoclaw-tray-empty', staged.length === 0);
    staged.forEach((a, i) => {
      const chip = this.trayEl.createSpan({ cls: 'nanoclaw-chip', text: (a.shared ? '🔗 ' : '📎 ') + a.name + ' ' });
      if (a.shared) chip.setAttr('title', `shared live at ${a.vaultPath} — the agent edits this file, not a copy`);
      const x = chip.createSpan({ cls: 'nanoclaw-chip-x', text: '×' });
      x.onclick = () => this.plugin.dropAttachment(this.plugin.activeId, i);
    });

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
    new Setting(containerEl).setName('Find my install')
      .setDesc('Scan your home folder for a nanoclaw install and point the paths below at it. The defaults are only a guess — an install directory can be named anything.')
      .addButton((b) => b.setButtonText('Detect').onClick(async () => {
        b.setDisabled(true).setButtonText('Scanning…');
        try { await this.plugin._autodetectInstall({ force: true }); this.display(); }
        finally { b.setDisabled(false).setButtonText('Detect'); }
      }));
    new Setting(containerEl).setName('Socket path').setDesc('nanoclaw obsidian.sock (multi-session channel). Auto-repaired when unreachable.')
      .addText((t) => t.setPlaceholder('(auto-detected)').setValue(this.plugin.settings.socketPath).onChange(async (v) => {
        this.plugin.settings.socketPath = v.trim();
        await this.plugin.saveSettings();
        // Drop any live connection so the next message dials the new path.
        // Without this the change appears to do nothing until the old socket
        // happens to close, which reads as "I fixed the setting and it's still
        // broken" — the exact confusion this field exists to resolve.
        this.plugin.resetSocket();
      }));
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
    new Setting(containerEl).setName('Models').setDesc('One `vendor/model` per line, offered by the model picker. Keep the vendor prefix — that is what selects which API is used. A new vendor also needs its API key in the OneCLI vault.')
      .addTextArea((tx) => tx.setValue((this.plugin.settings.models || []).join('\n')).onChange(async (v) => {
        this.plugin.settings.models = v.split('\n').map((s) => s.trim()).filter(Boolean);
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Model switch script').setDesc('Path to nanoclaw-model.sh (powers the model picker).')
      .addText((t) => t.setPlaceholder('(auto-detected)').setValue(this.plugin.settings.modelScript).onChange(async (v) => { this.plugin.settings.modelScript = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Key rotate script').setDesc('Path to nanoclaw-deepseek-key.sh (powers the "Rotate DeepSeek API key" command).')
      .addText((t) => t.setPlaceholder('(auto-detected)').setValue(this.plugin.settings.keyScript).onChange(async (v) => { this.plugin.settings.keyScript = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Shared folder')
      .setDesc('Vault folder that is also mounted into the agent (set up by nanoclaw-mount-vault.sh). When set, attached files land here instead of the agent\'s private inbox — one copy, visible to you, editable by both. Leave blank to use the inbox.')
      .addText((tx) => tx.setPlaceholder('shared-with-agent').setValue(this.plugin.settings.sharedFolder).onChange(async (v) => {
        this.plugin.settings.sharedFolder = this.plugin.toVaultRelative(v);
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName('Agent output folder').setDesc(`Vault folder where files ${this.plugin.settings.agentName} sends back are written (via send_file). Put it INSIDE the folder mounted into the agent (e.g. "workspace/${this.plugin.settings.agentName} Files") if you want it to be able to re-read and revise its own output — anywhere else in the vault is write-only from its side.`)
      .addText((tx) => tx.setValue(this.plugin.settings.outputFolder).onChange(async (v) => { this.plugin.settings.outputFolder = v.trim(); await this.plugin.saveSettings(); }));
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

// Pick the model (and therefore the vendor) for the agent. The list is a setting
// rather than hardcoded because vendors ship new model ids constantly; anything
// typed in is passed straight through, so a brand-new model works the day it
// lands without a plugin update.
class ModelPickerModal extends FuzzySuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder(`Switch model — current: ${plugin.modelLabel || '?'}`);
  }
  getItems() {
    const list = (this.plugin.settings.models || []).slice();
    const cur = this.plugin.modelLabel;
    if (cur && cur !== '?' && !list.includes(cur)) list.unshift(cur);
    return list;
  }
  getItemText(m) { return m === this.plugin.modelLabel ? `${m}  ✓ current` : m; }
  onChooseItem(m) { this.plugin.setModel(m); }
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
