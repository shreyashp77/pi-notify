// noti-pi — desktop notification when the agent finishes (Linux).
// Toast via notify-send; focus gate via xdotool (X11 only). No npm deps.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULTS = {
  enabled: true,
  onlyWhenFocusLost: true,
  title: "noti-pi",
  bodyTemplate: "",
  cooldownMs: 1500,
};

export default function (pi: ExtensionAPI) {
  const cfg = { ...DEFAULTS };
  let lastUserPrompt = "";
  let lastNotifiedAt = 0;
  let warnedMissingToast = false;

  pi.on("session_start", async (_event, ctx) => {
    lastUserPrompt = "";
    lastNotifiedAt = 0;
    Object.assign(cfg, readEnv());
    // Project config only if trusted; never throw.
    if (ctx.isProjectTrusted()) {
      const path = join(ctx.cwd, CONFIG_DIR_NAME, "extensions", "noti-pi", "config.json");
      if (existsSync(path)) {
        try {
          const data = JSON.parse(await readFile(path, "utf8"));
          for (const key of Object.keys(DEFAULTS)) {
            if (key in data) (cfg as Record<string, unknown>)[key] = data[key];
          }
        } catch {
          // malformed config -> keep env+defaults
        }
      }
    }
  });

  pi.on("message_start", (event) => {
    if (event.message?.role === "user") lastUserPrompt = textOf(event.message);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!cfg.enabled || ctx.mode !== "tui") return;
    if (cfg.onlyWhenFocusLost && await isTerminalFocused()) return;

    const now = Date.now();
    if (now - lastNotifiedAt < cfg.cooldownMs) return;
    lastNotifiedAt = now;

    const title = cfg.title;
    const body =
      cfg.bodyTemplate ||
      (lastUserPrompt ? `"${truncate(lastUserPrompt, 80)}" — done` : "Agent run finished");

    ctx.ui.notify(title, "info");
    pi.exec("notify-send", [title, body], { signal: ctx.signal, timeout: 4000 }).catch((err) => {
      if (!warnedMissingToast) {
        warnedMissingToast = true;
        ctx.ui.notify(`notify-send unavailable, inline-only (${String(err)})`, "warning");
      }
    });
  });

  async function isTerminalFocused(): Promise<boolean> {
    try {
      const { stdout } = await pi.exec("xdotool", ["getwindowfocus", "getwindowpid"], {
        timeout: 2000,
      });
      const focused = Number(stdout.trim());
      return Number.isFinite(focused) && (await ancestorPids()).has(focused);
    } catch {
      // ponytail: xdotool is X11-only; on Wayland/missing tool we can't tell,
      // so assume unfocused and notify anyway (never silent).
      return false;
    }
  }
}

// pi's ancestor PIDs: walk /proc/<pid>/status PPid up to PID 1 (or cycle).
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
    } catch {
      break;
    }
  }
  return pids;
}

function readEnv() {
  const env = process.env;
  const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : v !== "0" && v.toLowerCase() !== "false");
  const out: Record<string, unknown> = {};
  if (env.PI_NOTIFY_ENABLED !== undefined) out.enabled = bool(env.PI_NOTIFY_ENABLED, DEFAULTS.enabled);
  if (env.PI_NOTIFY_ONLY_FOCUS_LOST !== undefined)
    out.onlyWhenFocusLost = bool(env.PI_NOTIFY_ONLY_FOCUS_LOST, DEFAULTS.onlyWhenFocusLost);
  if (env.PI_NOTIFY_TITLE !== undefined) out.title = env.PI_NOTIFY_TITLE;
  if (env.PI_NOTIFY_BODY !== undefined) out.bodyTemplate = env.PI_NOTIFY_BODY;
  if (env.PI_NOTIFY_COOLDOWN !== undefined) {
    const n = Number(env.PI_NOTIFY_COOLDOWN);
    if (Number.isFinite(n) && n >= 0) out.cooldownMs = n;
  }
  return out;
}

function textOf(message: { content?: Array<{ type: string; text?: string }> | string }): string {
  const c = message.content;
  if (typeof c === "string") return c.trim();
  if (!Array.isArray(c)) return "";
  return c
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text)
    .join(" ")
    .trim();
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
