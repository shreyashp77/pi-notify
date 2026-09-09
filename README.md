# noti-pi

pi extension: fire a desktop notification the moment the agent finishes.
Built for: *ask a question → agent works a while → you switch windows →
`notify-send` toast pops up when it's done.*

Linux only. Zero runtime dependencies (`notify-send` for the toast,
`xdotool` for the focus gate — both optional; the extension degrades to
inline-only notification if they are missing).

## Install

```bash
pi install npm:@shreyashp7/noti-pi
```

## How it works

- Hooks `agent_settled` — fires only when the agent is truly idle (no
  pending retries, compaction, or follow-ups).
- Always posts an inline `ctx.ui.notify()`.
- In TUI mode also runs `notify-send "<title>" "<body>"`.
- Optional focus gate: if the focused X11 window's PID is an ancestor of pi,
  the terminal has focus and the toast is skipped (default on).
- Toast body defaults to the last user prompt (truncated) + "— done".

## Config

Env vars (first) or `.pi/extensions/noti-pi/config.json` (project file,
read only when the project is trusted):

| Key | Env | Default | Meaning |
|-----|-----|---------|---------|
| `enabled` | `PI_NOTIFY_ENABLED` | `true` | master switch |
| `onlyWhenFocusLost` | `PI_NOTIFY_ONLY_FOCUS_LOST` | `true` | skip if terminal focused |
| `title` | `PI_NOTIFY_TITLE` | `noti-pi` | toast title |
| `bodyTemplate` | `PI_NOTIFY_BODY` | auto | body override |
| `cooldownMs` | `PI_NOTIFY_COOLDOWN` | `1500` | min ms between toasts |

## Ceiling

`xdotool` is X11-only. On Wayland (or if `xdotool` is missing), the focus
check fails open: toasts always fire. That's intentional.
