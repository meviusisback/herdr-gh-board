// The last prompt an agent received, read from the agent's own store: the same sources the
// pane header uses (pi, omp, opencode, hermes). The sidebar has no screen of its own, so it
// always shows the last sent prompt rather than the one the terminal has scrolled to.
// Remote agents have no store here: their address names a machine, and the read returns "".

import { home, exec, terminals } from "herdr";

// pi keeps no map from a running process to its session file and the log is not held open, so
// the chat cannot find it from the pid. A small pi extension (pi/last-prompt.ts, symlinked into
// ~/.pi/agent/extensions) writes that map; the log then names the last prompt.
const PI_MAP = `${home()}/.config/herdr-app/data/last-prompt/sessions.json`;
// A tool-heavy turn pushes the last question far back: look in widening windows of the log.
const WINDOWS = [400_000, 1_500_000, 5_000_000, 15_000_000];

// A title can carry bidi overrides: they never reach the sidebar, so a name cannot reorder
// the rows beside it.
const plain = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

const flat = (s) => plain(s).replace(/\s+/g, " ").trim();

// A session id or a folder in a query: text is never trusted to close the quotes itself.
const sqlText = (value) => String(value ?? "").replace(/'/g, "''");

// One query, as rows of tab-separated fields. Field separators become spaces in the SQL, so a
// prompt's own tabs cannot split its row.
async function query(file, sql) {
  const r = await exec("sqlite3", ["-separator", "\t", "-noheader", file, sql]);
  if (r.code !== 0) throw new Error((r.stderr || "sqlite3 failed").trim());
  return String(r.stdout ?? "").split("\n").filter(Boolean).map((line) => line.split("\t"));
}

// The end of a file: a session log can be tens of MB, and only its tail matters here. Through
// `tail` rather than fs, because a mod's fs has no ranged reads.
async function tail(file, bytes) {
  // `--`: the path comes from a JSON map, so a leading dash must never become an option.
  const r = await exec("tail", ["-c", String(bytes), "--", file], { timeout: 15000 }).catch(() => null);
  return r && r.code === 0 ? String(r.stdout ?? "") : "";
}

// What a user message asked, or "" when it is not the person's words: compaction and system
// notes arrive as user messages too. A prompt sent through a skill is one user message as well,
// the skill's own text and then what the person typed after it, so that one is unwrapped rather
// than dropped.
function asked(text) {
  if (!text) return "";
  if (!text.startsWith("<")) return text;
  if (!text.startsWith("<skill")) return "";
  const end = text.indexOf("</skill>");
  if (end < 0) return "";
  const rest = text.slice(end + 8).trim();
  return rest && !rest.startsWith("<") ? rest : "";
}

// The newest user message inside the last `bytes` of the file, or "" when there is none there.
async function scanTail(file, bytes) {
  const text = await tail(file, bytes);
  if (!text.includes('"role":"user"')) return "";
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.includes('"role":"user"')) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry?.message?.content;
    const parts = Array.isArray(content) ? content : typeof content === "string" ? [{ type: "text", text: content }] : [];
    const prompt = flat(parts.filter((b) => b?.type === "text").map((b) => b.text).join(" "));
    const what = asked(prompt);
    if (!what) continue;
    return what;
  }
  return "";
}

// The map itself changes only when a pi session starts or ends: read it at most this often,
// and keep the last good copy when a read fails.
const PI_MAP_MS = 5000;
let PI_CACHE = { at: 0, map: null };

// The smallest tail window that last answered for a file: the next read starts there instead
// of at the widest. Bounded, because a machine with many sessions must not grow it forever.
const WIN_MEMO = new Map();
const WIN_MEMO_MAX = 100;

// The last thing the person typed into a pi session: the newest user message in its log.
async function lastUserMessage(file) {
  const memo = WIN_MEMO.get(file);
  const order = memo ? [memo, ...WINDOWS.filter((window) => window !== memo)] : WINDOWS;
  for (const window of order) {
    const found = await scanTail(file, window);
    if (!found) continue;
    if (memo !== window) {
      if (WIN_MEMO.size >= WIN_MEMO_MAX && !WIN_MEMO.has(file)) WIN_MEMO.delete(WIN_MEMO.keys().next().value);
      WIN_MEMO.set(file, window);
    }
    return found;
  }
  return "";
}

// The extension's pid -> session map, read through the memo above.
async function piSessions() {
  if (PI_CACHE.map && Date.now() - PI_CACHE.at < PI_MAP_MS) return PI_CACHE.map;
  try {
    const got = await exec("cat", [PI_MAP]);
    if (got.code === 0) PI_CACHE = { at: Date.now(), map: JSON.parse(String(got.stdout ?? "") || "{}") ?? {} };
  } catch { /* keep the previous map */ }
  return PI_CACHE.map ?? {};
}

// pi: pid -> session file (the extension's map), then the last user message in it.
async function piPrompt(p) {
  const rec = (terminals() ?? []).find((t) => t.address === p.terminal) ?? {};
  const pid = rec.foreground?.pid ?? rec.pid ?? null;
  if (!pid) return "";
  const map = await piSessions();
  const file = map?.[String(pid)]?.path;
  // The map is a local JSON file: a path it names is read only when it is an absolute path.
  return typeof file === "string" && file.startsWith("/") ? lastUserMessage(file) : "";
}

// omp: history.db keeps every prompt with the session it was sent to, and that session is the
// one whose title the terminal shows. The title is matched whole, never as a LIKE pattern: a
// short or unrelated title must not reach another session's prompts.
async function ompPrompt(p) {
  const file = `${home()}/.omp/agent/history.db`;
  const term = plain(p.title);
  const session = (await query(file, "SELECT session_id, title FROM session_titles ORDER BY updated_at DESC LIMIT 200;"))
    .find(([, title]) => title && term.includes(plain(title)));
  if (!session) return "";
  const prompts = await query(file,
    `SELECT replace(replace(prompt, char(10), ' '), char(9), ' ') FROM history
      WHERE session_id = '${sqlText(session[0])}' ORDER BY created_at DESC LIMIT 15;`);
  return prompts.map(([prompt]) => flat(prompt)).filter(Boolean)[0] ?? "";
}

// opencode: its own sqlite file, the session for this folder whose title the terminal shows,
// and the person's own messages in it.
async function opencodePrompt(p) {
  const file = `${home()}/.local/share/opencode/opencode.db`;
  const term = plain(p.title);
  const session = (await query(file,
    `SELECT id, title FROM session_v2 WHERE directory = '${sqlText(p.cwd)}' AND title IS NOT NULL
      ORDER BY time_updated DESC LIMIT 100;`))
    .find(([, title]) => title && term.includes(plain(title)));
  if (!session) return "";
  const prompts = await query(file,
    `SELECT replace(replace(json_extract(data, '$.text'), char(10), ' '), char(9), ' ') FROM session_message
      WHERE session_id = '${sqlText(session[0])}' AND type = 'user' ORDER BY seq DESC LIMIT 15;`);
  return prompts.map(([text]) => flat(text)).filter(Boolean)[0] ?? "";
}

// hermes: its terminal title is empty and its store keeps no pid, so the session is the one
// live local session for the folder. Two of them, or none, means no prompt: a guess is how a
// row ends up showing what another session was asked.
async function hermesPrompt(p) {
  const file = `${home()}/.hermes/state.db`;
  const live = await query(file,
    `SELECT id FROM sessions WHERE source = 'local' AND ended_at IS NULL AND cwd = '${sqlText(p.cwd)}'
      ORDER BY last_activity_at DESC LIMIT 2;`);
  if (live.length !== 1) return "";
  const prompts = await query(file,
    `SELECT replace(replace(content, char(10), ' '), char(9), ' ') FROM messages
      WHERE session_id = '${sqlText(live[0][0])}' AND role = 'user' AND active = 1
      ORDER BY timestamp DESC LIMIT 15;`);
  // Background work, delegated batches and skill invocations arrive as user messages too.
  return prompts.map(([text]) => flat(text)).filter((text) => text && !/^[\[<]/.test(text))[0] ?? "";
}

// The agents whose own store answers "what was asked here". One not here shows nothing: a
// title matched against another agent's history is how a row shows a prompt nobody sent.
const SOURCES = { omp: ompPrompt, opencode: opencodePrompt, hermes: hermesPrompt };

/** Whether this agent's prompt can be read here. */
export function readable(app) {
  return app === "pi" || Boolean(SOURCES[app]);
}

/** The last prompt of an agent (`agents()` entry) whose pane is in `cwd`, or "". */
export async function lastPrompt(agent, cwd) {
  if (!agent || String(agent.address ?? "").includes("/")) return "";
  const read = agent.app === "pi" ? piPrompt : SOURCES[agent.app];
  if (!read) return "";
  return read({ terminal: agent.address, title: agent.title, cwd, app: agent.app });
}
