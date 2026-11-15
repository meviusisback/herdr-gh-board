// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; an agent whose
// own store this mod can read (pi, omp, opencode) also shows a prompt on the
// right, up to half the header: the focused pane shows the prompt of the
// section on screen (the newest sent prompt visible in the terminal, else the
// last sent), other panes the last sent. Buttons split, zoom and close this
// pane. Props: { pane, terminal }. Click: focus.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, exec, hc, terminals, spaces, shared, setShared, notify, readTextFile } from "herdr";
import { planFromPackage, managerFrom, commandFor, scriptArgs, findUrls, reasonFrom, shellIdle, localPage, isAddress } from "./live.js";

// The live tests, one per folder: { terminal, url, name }. The + menu reads the same state,
// so a test started from a header is found there, and one started there opens from here.
const LIVE = "live-test";
const liveTests = () => {
  const all = shared(LIVE);
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
};
const baseName = (folder) => String(folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";

// pi keeps no map from a running process to its session file and the log is not held open, so
// the chat cannot find it from the pid. A small pi extension (pi/last-prompt.ts, symlinked into
// ~/.pi/agent/extensions) writes that map; the log then names the last prompt.
const PI_MAP = `${home()}/.config/herdr-app/data/last-prompt/sessions.json`;
// A tool-heavy turn pushes the last question far back: look in widening windows of the log.
const WINDOWS = [400_000, 1_500_000, 5_000_000, 15_000_000];

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

// A program sets its own title, and a title can carry bidi overrides: they never reach the
// header, so a name cannot reorder the chrome beside it.
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

// The newest sent prompt found on this pane's screen, else the last sent: scrolling back to an
// older question moves the header with it.
async function shown(p, prompts) {
  if (!prompts.length) return "";
  if (!p.focused || prompts.length < 2) return prompts[0];
  try {
    const vis = await hc(["read", p.terminal, "--lines", "0", "--json"]);
    if (vis.code !== 0) return prompts[0];
    const screen = flat(JSON.parse(vis.stdout).text ?? "");
    // Newest first: the first prompt found on screen wins (its head must match — the tail
    // may be scrolled or wrapped away).
    return prompts.find((prompt) => prompt.length > 12 && screen.includes(prompt.slice(0, 80))) ?? prompts[0];
  } catch { return prompts[0]; }
}

// The end of a file: a session log can be tens of MB, and only its tail matters here. Through
// `tail` rather than fs, because a mod's fs has no ranged reads.
async function tail(file, bytes) {
  // `--`: the path comes from a JSON map, so a leading dash must never become an option.
  const r = await exec("tail", ["-c", String(bytes), "--", file], { timeout: 15000 }).catch(() => null);
  return r && r.code === 0 ? String(r.stdout ?? "") : "";
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
    const line2 = flat(parts.filter((b) => b?.type === "text").map((b) => b.text).join(" "));
    const what = asked(line2);
    if (!what) continue;
    return what;
  }
  return "";
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
  return shown(p, prompts.map(([prompt]) => flat(prompt)).filter(Boolean));
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
  return shown(p, prompts.map(([text]) => flat(text)).filter(Boolean));
}

// hermes: its terminal title is empty and its store keeps no pid, so the session is the one
// live local session for the folder. Two of them, or none, means no prompt: a guess is how a
// pane ends up showing what another session was asked.
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
  return shown(p, prompts.map(([text]) => flat(text)).filter((text) => text && !/^[\[<]/.test(text)));
}

// The agents whose own store answers "what was asked here". One not here shows nothing: a
// title matched against another agent's history is how a pane shows a prompt nobody sent.
const SOURCES = { omp: ompPrompt, opencode: opencodePrompt, hermes: hermesPrompt };

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.prompts = {}; // terminal -> { prompt, at }; refreshed while shown
    // A 5 s tick with the 10 s per-pane guard: the guard is stamped when a read finishes, so a
    // tick at the guard's own period would skip every other one.
    cx.timer.every(5000, (cx) => this.refreshPrompt(cx));
    this.refreshPrompt(cx);
  }

  // The prompt this pane's agent last received, from that agent's own store. Asked at most
  // every 10 s per pane; never blocks a render, and a read that fails keeps the previous
  // prompt while one that finds nothing clears it (an old prompt is not this session's).
  refreshPrompt(cx) {
    const p = this.me();
    if (!p?.terminal || !p?.status) return;
    const seen = this.prompts[p.terminal];
    if (this.asking === p.terminal || (seen && Date.now() - seen.at < 10000)) return;
    const read = p.app === "pi" ? piPrompt : SOURCES[p.app];
    if (!read) return;
    this.asking = p.terminal;
    cx.spawn(async (cx) => {
      let prompt;
      try { prompt = await read(p); } catch { prompt = seen?.prompt ?? ""; }
      this.prompts[p.terminal] = { prompt, at: Date.now() };
      this.asking = null;
      // An unchanged prompt is a fresh timestamp, not a reason to redraw the header. A read on a
      // pane that never showed one is a change only when it found something.
      if (!seen ? prompt !== "" : prompt !== seen.prompt) cx.notify();
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  // What a live test would run in this folder: the package manager's dev/start script, else a
  // static server for an index.html.
  async planFor(folder) {
    const pkg = await readTextFile(`${folder}/package.json`);
    if (pkg != null) {
      const found = planFromPackage(pkg);
      if (found.error) return { why: found.error };
      const locks = await Promise.all([
        readTextFile(`${folder}/pnpm-lock.yaml`).catch(() => null),
        readTextFile(`${folder}/bun.lock`).catch(() => null),
        readTextFile(`${folder}/bun.lockb`).catch(() => null),
        readTextFile(`${folder}/yarn.lock`).catch(() => null),
      ]);
      const manager = managerFrom({ pnpm: locks[0] != null, bun: locks[1] != null || locks[2] != null, yarn: locks[3] != null });
      const cmd = commandFor(manager, found.script);
      // Typed into a shell it is one line; run in a new tab it is arguments, and the script's
      // name stays the one word it was in package.json.
      return { cmd, label: cmd, argv: scriptArgs(manager, found.script) };
    }
    if (await readTextFile(`${folder}/index.html`) != null) {
      return { cmd: "python3 -m http.server 4173 --bind 127.0.0.1", argv: ["bash", "-lc", "python3 -m http.server 4173 --bind 127.0.0.1"], label: "static server", url: "http://127.0.0.1:4173/" };
    }
    return { why: "no package.json or index.html here" };
  }

  // A URL is a page when it answers with HTML: a dev script that runs an API beside its web
  // app prints both, and the browser must get the app, not the API.
  async servesPage(url) {
    // Only a loopback URL is probed: the value may come from shared state, so it is re-checked
    // here rather than trusted, and `--` keeps it from reading as a curl option.
    if (!localPage(url)) return false;
    const probe = await exec("curl", ["-fsSL", "-m", "2", "-o", "/dev/null", "-w", "%{content_type}", "--", url],
      { timeout: 6000 }).catch(() => null);
    return probe?.code === 0 && /html/i.test(probe.stdout ?? "");
  }

  // The page a server printed, read from its terminal and probed: a URL counts only once it
  // serves HTML, so the API a dev script printed first is passed over for the app. A terminal
  // that ended stops the wait.
  async urlOf(address, cx) {
    if (!isAddress(address)) return null;
    let gone = 0, idle = 0;
    for (let i = 0; i < 30; i++) {
      const read = await exec("hc", ["read", address, "--lines", "200"], { timeout: 15000 }).catch(() => null);
      const out = read?.stdout ?? "";
      for (const url of findUrls(out).slice(-3).reverse()) if (await this.servesPage(url)) return url;
      // Back at the shell's prompt twice in a row: that command is over, no URL is coming.
      if (shellIdle(out)) { if (++idle >= 2) return null; } else idle = 0;
      if (terminals().some((t) => t.address === address && t.state === "live")) gone = 0;
      else if (++gone >= 3) return null;
      await cx.sleep(1000);
    }
    return null;
  }

  // The test's page: the URL it recorded while it answered, else one it printed just now. A
  // tab outlives its command, so a test whose server died answers nothing here.
  async pageOf(address, recorded, cx) {
    return (await this.servesPage(recorded)) ? recorded : await this.urlOf(address, cx);
  }

  // Why a start failed, in the toast's words: the port, the error, the exit code.
  async whyOf(address) {
    if (!isAddress(address)) return "";
    const read = await exec("hc", ["read", address, "--lines", "120"], { timeout: 15000 }).catch(() => null);
    return reasonFrom(read?.stdout ?? "").slice(0, 240);
  }

  // The command in the tab that already holds this folder's shell (a finished test leaves its
  // tab behind), else in a tab of its own: the terminal it runs in.
  async startIn({ terminal, folder, space, cmd, argv, name }) {
    // A remembered tab is typed into only while a shell sits at its prompt: an editor or a
    // pager left running there would take the text as its own keystrokes. The address is
    // re-checked because it came from shared state.
    if (terminal && isAddress(terminal) && terminals().some((t) => t.address === terminal && t.state === "live")) {
      const read = await exec("hc", ["read", terminal, "--lines", "12"], { timeout: 15000 }).catch(() => null);
      if (shellIdle(read?.stdout ?? "")) {
        const sent = await exec("hc", ["send", terminal, cmd], { timeout: 20000 }).catch(() => null);
        if (sent?.code === 0) return terminal;
      }
    }
    const made = await exec("herdr-app", ["do", "tab.new", "--name", name, "--space", space.id, "--folder", folder,
      "--argv", JSON.stringify(argv ?? ["bash", "-lc", cmd])], { timeout: 20000 });
    let out = {};
    try { out = JSON.parse(made.stdout || "{}"); } catch { /* not JSON: reported below */ }
    if (out.error) throw new Error(out.error);
    if (!out.terminal) throw new Error((made.stderr || "could not open the tab").trim());
    return out.terminal;
  }

  // The app's own opener: no shell to parse an `&` in a URL the terminal printed. Only a
  // loopback page is opened, so a value planted in shared state cannot launch anything else.
  openBrowser(url, cx) {
    if (!localPage(url)) return;
    cx.open_url(url);
  }

  // The header's live test: a test whose page answers opens in the browser; one that isn't
  // running — or whose server died behind its tab — is started again and opened. The header
  // lives while its pane does, so the wait outlives the click.
  async toggleLive(p, cx) {
    const folder = p?.cwd;
    if (!folder || this.liveBusy) return;
    const fail = (why) => notify({ title: "Live test failed", body: why, level: "error" });
    const save = (entry) => setShared(LIVE, { ...liveTests(), [folder]: entry });
    const space = spaces().find((s) => (s.tabs ?? []).some((tab) => tab.id === p.tab));
    if (!space) return;
    if (space.machine) return fail("Live tests run on this computer only");
    this.liveBusy = p.pane;
    cx.notify();
    const known = liveTests()[folder];
    const alive = Boolean(known) && terminals().some((t) => t.address === known.terminal && t.state === "live");
    try {
      const page = alive ? await this.pageOf(known.terminal, known.url, cx) : null;
      if (page) {
        if (page !== known.url) save({ ...known, url: page });
        this.openBrowser(page, cx);
        return;
      }
      const plan = await this.planFor(folder);
      if (!plan.cmd) throw new Error(plan.why ?? "nothing to run here");
      const name = known?.name ?? `live \u00b7 ${baseName(folder)}`;
      const terminal = await this.startIn({ terminal: alive ? known.terminal : null, folder, space, cmd: plan.cmd, argv: plan.argv, name });
      save({ terminal, url: null, name });
      const url = await this.pageOf(terminal, plan.url ?? null, cx);
      if (!url) throw new Error((await this.whyOf(terminal)) || `no page answered (see the tab "${name}")`);
      save({ terminal, url, name });
      this.openBrowser(url, cx);
      notify({ title: "Live test", body: url, level: "success" });
    } catch (e) {
      fail(String(e?.message ?? e).slice(0, 300));
    } finally {
      this.liveBusy = null;
      cx.notify();
    }
  }

  // Beside the folder: one click opens the repo in the browser, starting its server when it is
  // not running. Always shown, so it can be found without hovering the header.
  liveButton(t, p, cx) {
    const entry = p.cwd ? liveTests()[p.cwd] : null;
    const running = Boolean(entry) && terminals().some((x) => x.address === entry.terminal && x.state === "live");
    const busy = this.liveBusy === p.pane;
    const tip = busy ? "Starting the live test…"
      : running ? `Open ${entry.url ?? "the live test"} in the browser`
      : "Start the live test and open it in the browser";
    return div().id(`ph-live-${p.pane}`).p(3).flex_none().rounded(4).cursor_pointer()
      .text_color(busy || running ? t.accent : t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        cx.spawn(async (cx) => { await this.toggleLive(p, cx); });
      })
      .child(busy ? div().frames(["\u25d0", "\u25d3", "\u25d1", "\u25d2"], 180).child("\u25d0")
        : svg("mods/workspace-chrome/monitor.svg").size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const prompt = this.prompts[p.terminal]?.prompt ?? "";
    const name = plain(((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell");
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(t.border)
      .text_size(12.5)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_none().min_w(0).max_w("55%").truncate().text_color(t.muted).child(folder(p.cwd)))
      .when(Boolean(p.cwd), (el) => el.child(this.liveButton(t, p, cx)))
      .child(div().flex_1())
      .when(Boolean(p.status) && Boolean(prompt) && prompt !== name, (el) => el.child(
        h_flex().flex_none().min_w(0).max_w("52%").gap(5).items_center()
          .tooltip(prompt)
          .child(div().flex_none().text_size(12).text_color(t.accent).child("❯"))
          .child(div().min_w(0).truncate().text_color(t.muted).child(prompt))))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(11.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
