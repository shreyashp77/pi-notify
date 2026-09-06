# pi-notify — "Notify me when the model finishes" (Linux only)

A pi extension that fires a **desktop notification** when the model finishes
responding — the moment the agent goes idle after doing its work. Built for the
flow: *user asks a query → model runs tools a while → user switches to another
window → model finishes → `notify-send` toast pops up.*

Linux only. Uses `notify-send` for the toast and `xdotool` for focus detection.
No npm dependency — Node built-ins + `pi.exec()` + two CLI tools
(`notify-send`, `xdotool`).

This is a self-contained spec. Paste it as context in a fresh chat to pick up
implementation.

---

## 1. What it does (and does not do)

**Does**
- Detect the exact moment an agent run fully settles (no more retries,
  compaction, or queued follow-ups).
- Emit a native desktop notification via `notify-send`, so it lands even when
  the terminal is not the focused window.
- Optionally skip the ping when the user is still watching the terminal.
- Also fire `ctx.ui.notify()` inline, so it's visible in the TUI regardless.

**Does NOT**
- Spawn any background process/timer/watcher from the factory function (pi
  forbids that; long-lived resources must start on `session_start`).
- Support macOS/Windows — out of scope.
- Work under Wayland focus detection (see §3 ceiling).

---

## 2. Why `agent_settled` (the core insight)

| Event | Fires when | Use |
|-------|-----------|-----|
| `turn_end` | each LLM response + tool-call round | per-turn, too chatty alone |
| `agent_end` | a low-level run ends — **but** pi may still auto-retry / auto-compact / queue follow-ups | **not** "done" yet |
| **`agent_settled`** | agent has **no retry/compaction/follow-up left**; `ctx.isIdle()` is true | ✅ definitive "finished" hook |

Use `agent_settled`. `agent_end` is a trap: it fires before auto-retry and
compaction-retry, so notifying there pings the user while work continues.
`agent_settled` fires once, only when the whole turn is truly over.

Supplementary events:
- `session_start` — load config, reset state.
- `session_shutdown` — nothing long-lived to clean (no timers started).
- `message_start` on `role === "user"` — remember the last prompt so the toast
  body can say *what* just finished.

---

## 3. Focus detection (Linux)

pi exposes **no** focus API, so use `xdotool`:

```
xdotool getwindowfocus getwindowpid
```

This prints the PID of the app owning the currently focused window. Compare it
against pi's own process ancestry: if the focused window's PID is an ancestor of
pi's process, the terminal is focused.

**Algorithm**
1. In Node, collect pi's ancestor PIDs by walking `/proc/self/status` `PPid`
   up to PID 1.
2. On notify, run `xdotool getwindowfocus getwindowpid` via `pi.exec`.
3. If the returned PID is in the ancestor set → terminal focused → (respect
   `onlyWhenFocusLost` and skip). Otherwise focus is elsewhere → notify.

**Ponytail ceiling (mark it):** `xdotool` only works on **X11**, not Wayland.
If `xdotool` is missing or returns nothing, treat the terminal as *not focused*
(i.e. notify anyway) so the feature never silently stops working. Also verify
`notify-send` exists once; if absent, warn once and fall back to inline-only.

---

## 4. Config

Read once per `session_start`, env first then project file.

| Key | Env | Default | Meaning |
|-----|-----|---------|---------|
| `enabled` | `PI_NOTIFY_ENABLED` | `true` | master switch |
| `onlyWhenFocusLost` | `PI_NOTIFY_ONLY_FOCUS_LOST` | `true` | skip notify if terminal is focused |
| `title` | `PI_NOTIFY_TITLE` | `pi-notify` | notification title |
| `bodyTemplate` | `PI_NOTIFY_BODY` | `""` (auto) | override body; empty = auto |
| `cooldownMs` | `PI_NOTIFY_COOLDOWN` | `1500` | min time between two toasts |

Auto body when `bodyTemplate` is empty: `"<first ~80 chars of last user prompt>" — done`,
or `"Agent run finished"` if no prompt tracked.

Config file (optional): `.pi/extensions/pi-notify/config.json` — read only when
`ctx.isProjectTrusted()`, using `CONFIG_DIR_NAME` from the agent package (don't
hardcode `.pi`).

---

## 5. Delivery

`notify(title, body)`:
1. If `ctx.hasUI === false` (print mode) → no-op.
2. Always `ctx.ui.notify(title, "info")` — cheap, always works.
3. If `ctx.mode === "tui"` → also `pi.exec("notify-send", [title, body], { signal: ctx.signal, timeout: 4000 })`.
   - Swallow a missing `notify-send` (warn once); never throw into the agent loop.

Debounce with `lastNotifiedAt` + `cooldownMs`.

---

## 6. File layout

Single file (simplest; ~120 lines):

```
~/.pi/agent/extensions/pi-notify.ts
```

Auto-discovered globally. Test with `pi -e ./pi-notify.ts`.

---

## 7. Reference implementation

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const cfg = { enabled: true, onlyWhenFocusLost: true, title: "pi-notify",
    bodyTemplate: "", cooldownMs: 1500 };
  let lastUserPrompt = "";
  let lastNotifiedAt = 0;
  let warnedMissingTool = false;

  pi.on("session_start", async (_e, ctx) => {
    lastUserPrompt = ""; lastNotifiedAt = 0;
    // load env + optional .pi/extensions/pi-notify/config.json here
  });

  pi.on("message_start", (e) => {
    if (e.message.role === "user") lastUserPrompt = textOf(e.message);
  });

  // ---- the feature ----
  pi.on("agent_settled", async (_e, ctx) => {
    if (!cfg.enabled || ctx.mode !== "tui") return;

    if (cfg.onlyWhenFocusLost && await isTerminalFocused()) return;

    const now = Date.now();
    if (now - lastNotifiedAt < cfg.cooldownMs) return;
    lastNotifiedAt = now;

    const title = cfg.title;
    const body = cfg.bodyTemplate ||
      (lastUserPrompt ? `"${truncate(lastUserPrompt, 80)}" — done` : "Agent run finished");

    ctx.ui.notify(title, "info");
    pi.exec("notify-send", [title, body], { signal: ctx.signal, timeout: 4000 })
      .catch(() => { if (!warnedMissingTool) { warnedMissingTool = true; } });
  });
}

// Collect pi's ancestor PIDs (walk /proc/self/status PPid to PID 1).
async function ancestorPids(): Promise<Set<number>> {
  const pids = new Set<number>();
  let pid = process.pid;
  for (let i = 0; i < 32; i++) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const m = status.match(/^PPid:\s+(\d+)/m);
      const parent = m ? Number(m[1]) : 0;
      if (!parent || pids.has(parent)) break;
      pids.add(parent);
      pid = parent;
    } catch { break; }
  }
  return pids;
}

// True if the focused X11 window is owned by an ancestor of pi (i.e. the terminal).
async function isTerminalFocused(): Promise<boolean> {
  try {
    const { stdout } = await pi.exec("xdotool", ["getwindowfocus", "getwindowpid"],
      { timeout: 2000 });
    const focused = Number(stdout.trim());
    return Number.isFinite(focused) && (await ancestorPids()).has(focused);
  } catch {
    return false; // xdotool/Wayland/missing -> assume not focused -> notify
  }
}

function textOf(message: { content: Array<{ type: string; text?: string }> }): string {
  return message.content.filter(c => c.type === "text" && c.text).map(c => c.text).join(" ").trim();
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
```

---

## 8. Edge cases

- **Retry storm** — `agent_settled` doesn't fire until truly idle; no premature ping.
- **Rapid settles** — `cooldownMs` debounce stops toast spam.
- **Print mode (`-p`)** — `ctx.mode !== "tui"` → skip OS notify.
- **Missing `notify-send`** — caught, warned once, never throws into agent loop.
- **Wayland / no `xdotool`** — `isTerminalFocused` returns false → notifies anyway.
- **Compaction / auto-retry** — covered by waiting on `agent_settled`.

---

## 9. Verify (manual test)

1. Install: copy to `~/.pi/agent/extensions/pi-notify.ts`, or run `pi -e ./pi-notify.ts`.
2. In pi: `write a 200-line script that does X, then run it` (forces a tool-heavy run).
3. While it works, switch to another window.
4. When it finishes, a `notify-send` toast should appear naming the task.
5. Focus path: keep pi focused → with `onlyWhenFocusLost=true` no toast; set
   `PI_NOTIFY_ONLY_FOCUS_LOST=false` → toast appears regardless.

---

## 10. Skipped / add-when

- **Sound / persistent notification** — add when one toast isn't enough
  (`notify-send --print-id`, or `-a` custom app name/icon).
- **Per-model / per-command allow-list** — add when the user wants to notify
  only for certain tools/prompts.
- **Wayland focus fallback** — add when the user runs Wayland (e.g. `wlrctl` /
  `hyprctl` foreground-window queries).
