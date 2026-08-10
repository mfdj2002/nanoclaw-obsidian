/**
 * Minimal stand-in for Obsidian's module, plus an in-memory vault.
 *
 * The plugin's risky logic — which path a file takes, what lands on the wire,
 * whether a write duplicates an existing file — is all plain JS sitting on a
 * thin `app.vault` surface. Stubbing that surface exercises the real code;
 * only Obsidian's own event plumbing (drag payloads, the native picker,
 * rendering) stays out of reach.
 */
class Plugin { constructor(app) { this.app = app; } }
class ItemView { constructor(leaf) { this.leaf = leaf; } }
class Modal { constructor(app) { this.app = app; } }
class FuzzySuggestModal { constructor(app) { this.app = app; } }
class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class Setting {
  constructor() {}
  setName() { return this; } setDesc() { return this; }
  addText() { return this; } addTextArea() { return this; }
  addToggle() { return this; } addButton() { return this; }
}
const notices = [];
class Notice { constructor(msg) { notices.push(String(msg)); } }

/** In-memory vault: path -> Buffer for files, path -> null for folders. */
function makeVault(initial = {}, basePath = '/Users/kite/cc/nano-test') {
  const files = new Map(Object.entries(initial).map(([p, v]) => [p, Buffer.from(v)]));
  const folders = new Set();
  const tfile = (p) => ({ path: p, name: p.split('/').pop(), extension: (p.split('.').pop() || '') });
  return {
    adapter: { basePath },
    _files: files,
    _folders: folders,
    getAbstractFileByPath(p) {
      if (files.has(p)) return tfile(p);
      if (folders.has(p)) return { path: p, name: p.split('/').pop() };
      return null;
    },
    async createFolder(p) {
      if (folders.has(p)) throw new Error('exists');
      folders.add(p);
    },
    async createBinary(p, ab) {
      if (files.has(p)) throw new Error('already exists: ' + p);
      files.set(p, Buffer.from(ab));
    },
    async readBinary(f) {
      const b = files.get(f.path);
      if (!b) throw new Error('missing: ' + f.path);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
    getMarkdownFiles() { return [...files.keys()].filter((p) => p.endsWith('.md')).map(tfile); },
  };
}

module.exports = { Plugin, ItemView, Modal, FuzzySuggestModal, PluginSettingTab, Setting, Notice, notices, makeVault };
