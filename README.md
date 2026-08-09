# Nanoclaw Chat (Obsidian plugin)

A minimal, no-build Obsidian plugin that chats with your **local [nanoclaw](https://github.com/nanocoai/nanoclaw) agent**
(DeepSeek + accumulated memory + OneCLI sandbox) over a Unix socket. It's the client
half of nanoclaw's **obsidian channel** — a paste-friendly sidebar instead of the
fragile terminal, with live thinking, parallel chats, and conversations saved as notes.

Plain JavaScript, zero dependencies, no build step. **Desktop-only** (uses Node's `net`;
Obsidian mobile has no Node runtime).

> Server side: the channel adapter lives in the nanoclaw fork at
> [`src/channels/obsidian.ts`](https://github.com/mfdj2002/nanoclaw/blob/kite/obsidian-channel/src/channels/obsidian.ts).
> Wire it with `pnpm exec tsx scripts/wire-obsidian.ts`. The two sides speak
> newline-delimited JSON; protocol below.

## Features

- **Multiple parallel tabs** — each tab is its own nanoclaw session (`threadId`-multiplexed),
  so chats run concurrently with no cross-talk.
- **Stop button** — interrupt an in-flight turn.
- **Live chain-of-thought** — a foldable 🧠 block streams the agent's reasoning as it fills
  in (~1×/sec, per reasoning round), then collapses when the answer lands.
- **Attach files** — 📎 or drop onto the panel. Works for files anywhere on disk (a PDF
  someone just emailed you) and for notes dragged out of the file explorer. The daemon
  saves each one into the agent's session inbox and tells the agent the path.
- **Files come back into the vault** — when the agent uses `send_file`, the plugin writes it
  into your **agent output folder** and links it. Ask it to *send* you a file rather than to
  save one to a path: its filesystem is not your vault, so a path it invents is a path you
  can't open.
- **Model / vendor picker** — pick from a configurable `vendor/model` list in the tab bar
  (shells out to `nanoclaw-model.sh`). Switching the vendor prefix switches which API is
  used, per agent group.
- **Auto-saved conversations** — each completed turn is appended to a normal `.md` note in
  your vault (full Obsidian rendering + native text selection). Reopen a saved chat back
  into a live tab from the `⌕` button.

## Install

Copy the three runtime files into your vault's plugin folder, then enable it:

```bash
VAULT=/path/to/your/vault
mkdir -p "$VAULT/.obsidian/plugins/nanoclaw-chat"
cp main.js manifest.json styles.css "$VAULT/.obsidian/plugins/nanoclaw-chat/"
```

Then in Obsidian: **Settings → Community plugins** → enable community plugins if off →
**Reload** → enable **"Nanoclaw Chat"**. Open it from the ribbon (message icon) or the
command palette → "Open Nanoclaw chat".

## Use

- **Enter** sends, **Shift+Enter** adds a newline (paste as much as you want).
- `+` opens a new tab; `⌕` reopens a saved chat note; the 🧠 chip switches model/vendor.
- The 🧠 thinking block shows reasoning live; scroll up while it streams and the view won't
  yank you down.
- **📎 or drop** to attach. Chips appear above the input; `×` removes one. Sending with
  attachments and no text is fine.

### Giving the agent documents

With a **Shared folder** configured, attaching does the least surprising thing: a file already
in that folder is handed over by path (no copy — you both edit the same file), and a file from
outside is copied into `<shared>/attachments/<thread>/`, where you can see it and delete it
whenever you like. Without one, files are sent into the agent's private session inbox instead,
which works but is invisible to you.

Either way the agent is told the exact path, so "summarize this" works. Whether it can *parse* a given format depends on its container tooling and model:

| Format | Works |
|---|---|
| `.md`, `.txt`, `.json`, `.csv`, `.html` | Yes — plain text it reads directly. |
| `.pdf`, `.docx` | Needs an extraction tool in the container. Ask the agent to install one (`install_packages`, admin-approved) or convert to text first. |
| Images | Needs a multimodal model or OCR. DeepSeek is text-only, so images alone won't be read. |

Large documents are still bounded by the model's context window — a long PDF may need to be
split. Ask for a chunked pass rather than expecting one shot.

## Settings

- **Find my install** — scans your home folder for a nanoclaw install and points the paths
  at it. The defaults are only a guess: an install directory can be named anything, so the
  plugin also re-scans automatically whenever the socket turns out to be unreachable.
- **Socket path** — `<install>/data/obsidian.sock`. Blank means "not located yet"; the plugin
  fills it in and re-detects whenever it becomes unreachable. There is deliberately no default
  path: an install directory can be named anything, and a wrong-but-plausible guess reports a
  healthy daemon as unreachable.
- **Agent name** — label on replies.
- **Chats folder** — where conversation `.md` notes are saved.
- **Shared folder** — a vault folder that is *also* mounted into the agent (set up by
  `nanoclaw-mount-vault.sh`, which gives it the same name on both sides). When set, attaching
  a file puts it here rather than in the agent's private session inbox, and a file already in
  here is handed over **by path, not by copy** — so the agent edits the same bytes you see.
  Blank falls back to the inbox.
- **Agent output folder** — where files the agent sends back are written. Put it inside the
  folder mounted into the agent (e.g. `workspace/Andy Files`) so it can re-read and revise its
  own output; anywhere else in the vault is write-only from its side.
- **Models** — one `vendor/model` per line, offered by the picker.
- **Silence / turn timeouts** — when to finalize after the last reply line / give up on a stalled turn.
- **Model switch script** — path to `nanoclaw-model.sh` (powers the model picker).

## Using a different API (Moonshot / Kimi, Zhipu, OpenRouter …)

The model id carries its vendor, so switching the prefix switches the API — per agent group,
not install-wide:

```bash
onecli secrets create --name moonshot --value sk-… --hosts api.moonshot.cn  # key lives in the vault, never in .env
nanoclaw-model.sh moonshotai/kimi-k3
```

Add the model to the **Models** setting to get it in the picker. If OpenCode doesn't already
know the vendor's base URL, set `OPENCODE_BASE_URL_MOONSHOTAI=https://api.moonshot.cn/v1` in
the install's `.env`. Check the vendor's own model list for the exact model id.

## Admin-gated changes

Some requests ("change where you store documents", "install a package") are admin-gated. The
agent cannot approve its own request and **there is no approve button here on purpose** — an
Obsidian socket client is not an authenticated identity, so granting it admin would hand
admin to anything that can write to the socket. When the agent hits one of these it now says
so plainly and prints the `ncl …` command for you to run in a terminal on the host. If the
agent ever claims a change is "waiting for approval", that's stale behaviour — update the
daemon.

## Requirements

- The nanoclaw daemon running, with the obsidian channel wired to an agent group.
- Credit with whichever model vendor you've configured, and its key in the OneCLI vault
  (an unfunded DeepSeek account returns "Insufficient Balance"; a missing key returns 401).

## Wire protocol

Newline-delimited JSON over the socket:

- **plugin → host:** `{ "threadId": string, "text": string, "attachments"?: [{ "name": string, "data": base64, "type"?: string }] }`
- **host → plugin:** `{ "threadId": string|null, "text": string, "kind": "thinking" | "final", "files"?: [{ "name": string, "data": base64 }] }`

`kind:"thinking"` is the streamed (cumulative) CoT; `kind:"final"` is the answer. Replies
are broadcast to all connected clients; each filters by the `threadId` it owns.

`attachments` and `files` are optional; either side may send a message with files and empty
text. Limits: 20 attachments per message, 32MB each, 48MB per wire line. An oversized line is
skipped — framing resynchronizes at the next newline and you get a warning back, rather than
the connection dropping mid-turn. Raise them in the daemon's `.env` if you routinely hand over
large documents (`NANOCLAW_OBSIDIAN_MAX_ATTACHMENTS`, `NANOCLAW_OBSIDIAN_MAX_ATTACHMENT_MB`,
`NANOCLAW_OBSIDIAN_MAX_LINE_MB`); keep the line limit above the attachment limit, since base64
inflates by about a third.

## Validate the transport without Obsidian

```bash
node socket-test.js "hello"      # or obsidian-socktest.js for the two-thread probe
```
