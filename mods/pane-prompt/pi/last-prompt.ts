// For the Herdr app's pane header (mods/pane-prompt): pi keeps no map from a running process to
// its session file, and does not hold the log open, so the header cannot find the last prompt
// from the pid herdr-core reports. This records it: pid -> { path, cwd } in
// ~/.config/herdr-app/data/last-prompt/sessions.json.
//
// Installed by symlinking into ~/.pi/agent/extensions/. It writes nothing else, opens no
// socket, and does nothing when the file cannot be written.
import fs from "node:fs";
import path from "node:path";

const HOME = process.env.HOME || "";
const DIR = path.join(HOME, ".config/herdr-app/data/last-prompt");
const FILE = path.join(DIR, "sessions.json");
const KEEP_MS = 24 * 60 * 60 * 1000;

function update(pid, entry) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(FILE, "utf8")) || {}; } catch { all = {}; }
  const now = Date.now();
  for (const [key, value] of Object.entries(all)) {
    const at = Number(value?.at) || 0;
    if (now - at > KEEP_MS || String(key) === String(pid)) delete all[key];
  }
  if (entry) all[String(pid)] = { ...entry, at: now };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // A kill between the write and the rename leaves its temp file behind: sweep the old ones.
    for (const name of fs.readdirSync(DIR)) {
      if (!/^sessions\.json\..*\.tmp$/.test(name)) continue;
      const stale = path.join(DIR, name);
      try { if (now - fs.statSync(stale).mtimeMs > KEEP_MS) fs.rmSync(stale); } catch { /* not ours to remove */ }
    }
    const temp = `${FILE}.${pid}.tmp`;
    // The transcript paths and cwds it holds are the person's: readable by them, by no one else.
    fs.writeFileSync(temp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(temp, FILE);
  } catch { /* the header simply shows no prompt */ }
}

function report(ctx) {
  const file = ctx?.sessionManager?.getSessionFile?.();
  if (!file) return;
  const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.() ?? process.cwd();
  update(process.pid, { path: String(file), cwd: String(cwd) });
}

export default function (pi) {
  pi.on("session_start", (_event, ctx) => report(ctx));
  pi.on("agent_start", (_event, ctx) => report(ctx));
  pi.on("agent_settled", (_event, ctx) => report(ctx));
  pi.on("session_shutdown", () => update(process.pid, null));
}
