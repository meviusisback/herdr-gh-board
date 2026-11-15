import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, panes, focused, knownAgents, run, openOverlay, closeOverlay, props, window, keys, shared, setShared, terminals, exec, readTextFile, notify } from "herdr";
import { planFromPackage, managerFrom, commandFor, scriptArgs, findUrls, reasonFrom, shellIdle, localPage, isAddress } from "./live.js";

// The last agents each machine reported, shown at once while knownAgents() checks again.
// Where a launch goes: a new tab, or a split right/down of the focused pane in a repo's
// folder of its own (`terminal.open` takes the folder; `pane.split` has none).
//
// `props().space` names the space a launch goes to, for the copies the spaces panel opens from
// a branch row's bot; without it this copy speaks for the shown space, as the tab bar's + does.
// `props().comic` draws it as a callout bubble — dot on the clicked icon, leader, bubble — in
// place of Herdr's popup frame (frame: "none").
const KNOWN = "new-menu.agents";
// The branch row whose bot opened a copy of this menu (its `props().space`), and whether it is
// still up: the row's bot reads this to close the menu when pressed again instead of opening a
// second one over it. `closed` plus the moment it was set settles which came first, the press on
// the bot or the popup's own outside-press dismissal.
const MENU = "spaces-tree.branch-menu";

// The running live tests, one per folder: { terminal, url, name }. A terminal that ended
// (its tab was closed, or the server quit) is not shown as a test until it starts again.
const LIVE = "live-test";
const liveTests = () => {
  const all = shared(LIVE);
  return all && typeof all === "object" && !Array.isArray(all) ? all : {};
};

// The folder's own name, for a tab that says what it serves.
const baseName = (folder) => String(folder ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "repo";
const hostOf = (url) => String(url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
const isLive = (address) => terminals().some((t) => t.address === address && t.state === "live");

// Pinned to the top of the menu, in this order. Matched against the agent key
// and name case-insensitively; entries that don't match anything are ignored.
const PINNED = ["hermes", "oh my pi", "pi"];
const pinRank = (a) => {
  const hay = `${a.key ?? ""} ${a.name ?? ""}`.toLowerCase();
  const i = PINNED.findIndex((p) => hay.includes(p));
  return i < 0 ? PINNED.length : i;
};

// One read of the keybindings per menu: the rows share it instead of asking per shortcut.
function shortcut(name, bindings) {
  const k = bindings.find(b => b.section === "global" && b.action === name);
  if (!k?.keys.trim()) return "";
  const mac = window()?.platform === "macos";
  const names = mac ? { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘", fn: "fn" } : { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Super", fn: "Fn" };
  const alias = { secondary: mac ? "cmd" : "ctrl", super: "cmd", win: "cmd" };
  return k.keys.trim().split(/\s+/).map(stroke => {
    const parts = stroke.split("-");
    let key = parts.pop();
    if (key === "") { key = "-"; parts.pop(); }
    const held = new Set(parts.map(m => alias[m.toLowerCase()] ?? m.toLowerCase()));
    if (/^[A-Z]$/.test(key)) held.add("shift");
    const label = key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1).toLowerCase();
    return [...Object.keys(names).filter(m => held.has(m)).map(m => names[m]), label].join(mac ? "" : "+");
  }).join(" ");
}

export default class NewMenu extends View {
  init(given, cx) {
    const space = this.spaceOf(given?.space) ?? spaces().find(s => s.active) ?? null;
    const machine = space?.machine;
    const where = machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.place = "tab"; // "tab" | "right" | "down"
    this.folder = null; // null: the focused pane's folder (the space's own repo)
    this.starting = {}; // folder -> true while its server is being started
    this.progress = {}; // folder -> what the start is waiting for
    this.error = {}; // folder -> why the last start failed
    this.handle = cx.focus_handle();
    this.handle.focus();
    // A test whose terminal ended (its tab was closed, the server quit) is not remembered.
    const known = liveTests();
    const alive = Object.fromEntries(Object.entries(known).filter(([, e]) => e && isLive(e.terminal)));
    if (Object.keys(alive).length !== Object.keys(known).length) setShared(LIVE, alive);
    cx.spawn(async cx => {
      try {
        this.agents = await knownAgents({ on: machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      }
      catch { this.failed = true; }
      cx.notify();
    });
  }

  // The overlay is going: say so, so the bot that opened it closes rather than reopens on the
  // next press. The tab bar's own + menu has no branch row and writes nothing.
  async close(_cx) {
    const space = props()?.space;
    if (!space) return;
    // A newer copy may already have opened over this one (a press on another row's bot): its
    // record is the truth, and this close must not overwrite it.
    const mark = shared(MENU);
    if (mark?.overlay && mark.overlay !== props()?.overlay) return;
    setShared(MENU, { space, overlay: props()?.overlay ?? null, at: Date.now(), closed: true });
  }

  // The space a launch goes to: the branch row's own when this copy came from one, else the
  // shown space. `spaceOf` is the lookup by id, so init can use it before props() settles.
  spaceOf(id) {
    return id ? spaces().find(s => s.id === id) ?? null : null;
  }

  target() {
    return this.spaceOf(props()?.space) ?? spaces().find(s => s.active) ?? null;
  }

  // The folder a launch starts in: the one picked, else where the pane with the keyboard is
  // (a popup doesn't take it from the model, though `panes().focused` reads false while it is
  // open), else the space itself.
  folderNow(active) {
    const f = focused();
    const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
    return this.folder ?? pane?.cwd ?? f?.cwd ?? active?.folder ?? null;
  }

  // What a live test would run in this folder: the package manager's dev/start script,
  // else a static server for an index.html. Read once per folder the menu is opened on.
  async planFor(folder) {
    try {
      const pkg = await readTextFile(`${folder}/package.json`);
      if (pkg != null) {
        const found = planFromPackage(pkg);
        if (found.error) return { state: "error", why: found.error };
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
        return { state: "ok", plan: { cmd, label: cmd, argv: scriptArgs(manager, found.script) } };
      }
      if (await readTextFile(`${folder}/index.html`) != null) {
        return { state: "ok", plan: { cmd: "python3 -m http.server 4173 --bind 127.0.0.1", argv: ["bash", "-lc", "python3 -m http.server 4173 --bind 127.0.0.1"], label: "static server", url: "http://127.0.0.1:4173/" } };
      }
      return { state: "error", why: "no package.json or index.html here" };
    } catch (e) {
      return { state: "error", why: String(e?.message ?? e) };
    }
  }

  save(folder, entry) {
    setShared(LIVE, { ...liveTests(), [folder]: entry });
  }
  forget(folder) {
    const all = { ...liveTests() };
    delete all[folder];
    setShared(LIVE, all);
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
  // that ended (the tab was closed, the server failed) is not waited on: `terminals()` can lag
  // just after a launch, so it takes three misses to call it gone.
  async urlOf(address, cx) {
    if (!isAddress(address)) return null;
    let gone = 0, idle = 0;
    for (let i = 0; i < 30; i++) {
      const read = await exec("hc", ["read", address, "--lines", "200"], { timeout: 15000 }).catch(() => null);
      const out = read?.stdout ?? "";
      for (const url of findUrls(out).slice(-3).reverse()) if (await this.servesPage(url)) return url;
      // Back at the shell's prompt twice in a row: that command is over, no URL is coming.
      if (shellIdle(out)) { if (++idle >= 2) return null; } else idle = 0;
      if (isLive(address)) gone = 0;
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
    // pager left running there would take the text as its own keystrokes.
    if (terminal && isAddress(terminal) && isLive(terminal)) {
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

  // Start the folder's server in a tab of its own, wait for its page, and open the browser on
  // it. A test whose tab is still there with its shell back (its server died) is started again
  // in that tab, not in a second one. The menu stays up until the page opens, because a task
  // ends with the popup that started it.
  async start(folder, cx) {
    if (!folder || this.starting[folder]) return;
    const space = this.target();
    if (!space) return;
    const fail = (why) => {
      this.error = { ...this.error, [folder]: why };
      notify({ title: "Live test failed", body: why, level: "error" });
      cx.notify();
    };
    if (space.machine) return fail("Live tests run on this computer only");
    this.starting = { ...this.starting, [folder]: true };
    const step = (text) => { this.progress = { ...this.progress, [folder]: text }; cx.notify(); };
    const errors = { ...this.error };
    delete errors[folder];
    this.error = errors;
    const known = liveTests()[folder];
    const alive = Boolean(known) && isLive(known.terminal);
    step("reading the folder…");
    try {
      const found = await this.planFor(folder);
      if (found.state !== "ok") throw new Error(found.why ?? "nothing to run here");
      const plan = found.plan;
      const name = `live · ${baseName(folder)}`;
      step(alive ? "starting it again…" : "opening the tab…");
      const terminal = await this.startIn({ terminal: alive ? known.terminal : null, folder, space, cmd: plan.cmd, argv: plan.argv, name });
      this.save(folder, { terminal, url: null, name });
      step("waiting for the page…");
      const url = await this.pageOf(terminal, plan.url ?? null, cx);
      if (!url) throw new Error((await this.whyOf(terminal)) || `no page answered (see the tab "${name}")`);
      this.save(folder, { terminal, url, name });
      this.openBrowser(url, cx);
      notify({ title: "Live test", body: url, level: "success" });
      closeOverlay(props().overlay);
    } catch (e) {
      fail(String(e?.message ?? e));
    } finally {
      const running = { ...this.starting };
      delete running[folder];
      this.starting = running;
      cx.notify();
    }
  }

  // A test already running: the browser again, on the page its terminal serves. A tab whose
  // server died is started again there instead of opening a page that is not there.
  async open(folder, cx) {
    const entry = liveTests()[folder];
    if (!entry) return;
    const page = await this.pageOf(entry.terminal, entry.url, cx);
    if (!page) return void (await this.start(folder, cx));
    if (page !== entry.url) this.save(folder, { ...entry, url: page });
    try {
      this.openBrowser(page, cx);
    } catch (e) {
      notify({ title: "Live test failed", body: String(e?.message ?? e), level: "error" });
    }
    closeOverlay(props().overlay);
  }

  stop(folder) {
    const entry = liveTests()[folder];
    if (entry) run("terminal.kill", { terminal: entry.terminal });
    this.forget(folder);
    closeOverlay(props().overlay);
  }

  // A new tab (as before), or a split of the focused pane running there. Started from a branch
  // row's bot, the eye goes to that space first: the new agent (or split) is what to look at,
  // and a split acts on the focused pane of the space it is in.
  launch(argv, name) {
    const space = this.target();
    const shown = spaces().find(s => s.active);
    if (space && space.id !== shown?.id) run("space.select", { id: space.id });
    if (this.place === "tab") {
      run("tab.new", argv ? { name, space: space?.id, argv } : { space: space?.id });
      return;
    }
    const args = { place: this.place };
    if (argv) { args.argv = argv; args.name = name; }
    const folder = this.folderNow(space);
    if (folder) args.folder = folder;
    run("terminal.open", args);
  }

  // One choice per folder a space lives in: the agents of another repo are two
  // clicks away. The shown space comes first.
  repos() {
    const out = [];
    const here = this.target()?.id;
    for (const s of spaces()) {
      if (s.folder && !out.some(r => r.folder === s.folder)) out.push({ folder: s.folder, name: s.name, active: s.id === here });
    }
    return out.sort((a, b) => Number(b.active) - Number(a.active));
  }

  row(id, icon, name, action, hint = "", enabled = true, keep = false) {
    const t = theme();
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, el => el.hover(s => s.bg(t.selected)))
      .on_click((_e, cx) => { if (enabled) { if (!keep) closeOverlay(props().overlay); action(cx); } })
      .child(icon).child(div().flex_1().truncate().child(name)).child(div().text_size(12).max_w(150).truncate().text_color(t.muted).child(hint));
  }
  render() {
    const t = theme();
    const bindings = keys();
    const space = this.target();
    const installed = this.agents.filter(a => a.installed)
      .sort((x, y) => pinRank(x) - pinRank(y));
    const choices = [...installed, ...this.agents.filter(a => !a.installed).slice(0, 2)];
    const repos = this.repos();
    const now = this.folderNow(space);
    // The live test of the folder on screen: running in a tab of its own, being started,
    // or to be started. The plan is read from package.json (or index.html) once per folder.
    const live = now ? liveTests()[now] : null;
    const running = Boolean(live) && isLive(live.terminal);
    const busy = Boolean(now && this.starting[now]);
    const failure = now ? this.error[now] : null;
    // The row is shown whenever the menu speaks about a folder here: a click reads the
    // folder and says why when there is nothing to run.
    const liveEnabled = Boolean(now) && !space?.machine && !busy;
    // Tab / Split → / Split ↓: a split runs the chosen agent in the chosen repo's
    // folder, so two repos sit side by side in the shown tab.
    const place = (value, label) => div().id(`place-${value}`).h(24).px(9).flex().items_center().rounded(6).text_size(12.5).flex_none()
      .bg(this.place === value ? t.selected : t.raised).text_color(this.place === value ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.place = value; cx.notify(); }).child(label);
    const repo = (r) => div().id(`repo-${r.name}`).h(24).max_w(150).px(9).flex().items_center().rounded(6).text_size(12.5).truncate()
      .bg(now === r.folder ? t.selected : t.raised).text_color(now === r.folder ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { this.folder = this.folder === r.folder ? null : r.folder; cx.notify(); })
      .child(r.name);
    const comic = Boolean(props()?.comic);
    const BUBBLE = 232; // the balloon; the leader takes the rest of the popup
    const LEAD = 28;
    const height = Math.min(491, 227 + (this.place === "tab" ? 0 : 29) + Math.max(1, choices.length) * 31);
    const panel = v_flex().min_h(0).bg(t.popover).p(5).text_size(12.8)
      .id("new-menu").track_focus(this.handle)
      .when(comic, (el) => el.w(BUBBLE).h(height).rounded(12).rounded_tl(3).border_1().border_color(t.border).shadow_lg())

      .when(!comic, (el) => el.w_full().h(height))
      .on_key_down((e) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (!agent) return;
        closeOverlay(props().overlay);
        this.launch(agent.run, agent.name);
      })
      .child(h_flex().id("place").flex_none().h(29).items_center().gap(3).px(5).children([
        place("tab", "Tab"), place("right", "Split \u2192"), place("down", "Split \u2193")]))
      .when(this.place !== "tab", el => el.child(h_flex().id("repos").flex_none().h(29).items_center().min_w(0).gap(3).px(5).overflow_x_scrollbar().children([
        div().flex_none().text_size(12).text_color(t.muted).child("In"), ...repos.map(repo)])))
      .child(this.row("terminal", svg("icons/shell.svg").size(14), "Terminal", () => this.launch(), this.place === "tab" ? shortcut("tab.new", bindings) : ""))
      .child(div().px(9).pt(8).pb(4).text_size(12).text_color(t.muted).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .child(this.row("live", svg("mods/workspace-chrome/monitor.svg").size(14),
          busy ? "Starting live test…" : running ? "Open live test" : "Live test in browser",
          (cx) => cx.spawn(async (cx) => { if (running) await this.open(now, cx); else await this.start(now, cx); }),
          busy ? (this.progress[now] ?? "starting…") : running ? (live.url ? hostOf(live.url) : "starting…") : "",
          liveEnabled, true))
        .when(running, el => el.child(this.row("live-stop", svg("mods/pane/close.svg").size(13), "Stop live test", () => this.stop(now), "server", true, true)))
        .when(Boolean(failure), el => el.child(div().px(9).pb(4).text_size(12).text_color(t.blocked).child(failure)))
        .children(choices.map((a, i) => this.row(a.key, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14), a.name,
          () => this.launch(a.run, a.name), a.installed ? (i < 9 ? String(i + 1) : "") : "not installed", a.installed)))
        .when(this.agents.length === 0, el => el.child(div().px(9).py(6).text_color(t.muted).child(this.failed ? "Could not load agents" : "Checking installed agents…"))))
      .child(div().h(1).mx(4).my(5).bg(t.border))
      .child(this.row("space", div().w(14).child("+"), "New space", () => openOverlay({ mod: "space-new", kind: "dialog", width: 430, height: 286 }), shortcut("mod.open:space-new", bindings)))
      .child(this.row("worktree", svg("mods/workspace-chrome/branch.svg").size(14), "New worktree…", () => openOverlay({ mod: "worktree-gh", kind: "dialog", width: 460, height: 300, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "new" } }), "", Boolean(space)))
      .child(this.row("worktree-open", svg("mods/workspace-chrome/branch.svg").size(14), "Open worktree\u2026", () => openOverlay({ mod: "worktree-gh", kind: "dialog", width: 560, height: 480, props: { space: space?.id, folder: panes().find(p => p.focused)?.cwd, action: "open" } }), "", Boolean(space)))
      .child(this.row("settings", svg("mods/workspace-chrome/settings.svg").size(14), "Settings\u2026", () => run("mod.open", { name: "settings" }), shortcut("mod.open:settings", bindings)));
    if (!comic) return panel;
    // A callout, not a floating panel: the popup's own top-left is the pointer, so the dot sits
    // on the icon that was pressed and a leader carries the eye from it into the bubble. Herdr's
    // popup frame is off for this copy (frame: "none"), so the bubble draws its own edge.
    return div().relative().w(BUBBLE + LEAD).h(height)
      .child(panel.absolute().left(LEAD).top(0))
      .child(svg("mods/new-menu-pinned/leader.svg").absolute().left(0).top(0).w(LEAD).h(26).text_color(t.input));
  }
}
