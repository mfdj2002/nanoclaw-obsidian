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
- **Fast/Pro model toggle** — flip DeepSeek `v4-flash` ⇄ `v4-pro` from the tab bar
  (shells out to `nanoclaw-model.sh`).
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
- `+` opens a new tab; `⌕` reopens a saved chat note; the `⚡ fast` / `💎 pro` chip toggles the model.
- The 🧠 block shows reasoning live; scroll up while it streams and the view won't yank you down.

## Settings

- **Socket path** — defaults to `~/cc/nanoclaw-v2/data/obsidian.sock`.
- **Agent name** — label on replies.
- **Chats folder** — where conversation `.md` notes are saved.
- **Silence / turn timeouts** — when to finalize after the last reply line / give up on a stalled turn.
- **Model switch script** — path to `nanoclaw-model.sh` (powers the fast/pro toggle).

## Requirements

- The nanoclaw daemon running, with the obsidian channel wired to an agent group.
- A funded DeepSeek balance (otherwise the agent returns an "Insufficient Balance" error).

## Wire protocol

Newline-delimited JSON over the socket:

- **plugin → host:** `{ "threadId": string, "text": string }`
- **host → plugin:** `{ "threadId": string|null, "text": string, "kind": "thinking" | "final" }`

`kind:"thinking"` is the streamed (cumulative) CoT; `kind:"final"` is the answer. Replies
are broadcast to all connected clients; each filters by the `threadId` it owns.

## Validate the transport without Obsidian

```bash
node socket-test.js "hello"      # or obsidian-socktest.js for the two-thread probe
```
