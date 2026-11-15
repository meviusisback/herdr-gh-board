import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, panes, focused, exec, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

// The per-space panel choice, as this mod last wrote it — anything else is ignored,
// because a value this mod cannot read must not take the whole tab bar down.
function panels() {
  try {
    const value = JSON.parse(localStorage.getItem("panels") ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

// Reads that write nothing under .git (see mods/changes): the numbers are read often,
// and a lock file would make each read a change of its own.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
// The branch the work will land on: the remote's main when there is one, else the local.
const BASE_REFS = ["origin/main", "origin/master", "main", "master"];

// A space or agent can name itself, and a name can carry bidi overrides: they never reach
// the bar, only the wall chip's tooltip, and there stripped.
const plain = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

// The folder the bar speaks about: the focused pane's, else the active space's. The same
// source mods/changes reads, so the button and the panel describe one place.
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const locationKey = (at) => `${at.on ?? ""}|${at.cwd ?? ""}`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = panels();
    this.diff = null; // { key, at, base, add, del, files, error }
    this.measuring = false;
    this.measureDiff(cx);
    cx.timer.every(10000, (cx) => this.measureDiff(cx));
  }

  // "Changes vs origin/main" in the bar: git's own addition and deletion counts, not a
  // guess from the panel's list. Two calls per folder; the 10s clock and a fresh guard
  // keep a render from starting one, and a result for another folder is never shown.
  measureDiff(cx, at = location()) {
    const key = locationKey(at);
    if (this.measuring || (this.diff?.key === key && Date.now() - (this.diff.at ?? 0) < 9000)) return;
    if (!at.cwd) {
      if (this.diff && this.diff.key !== key) { this.diff = null; cx.notify(); }
      return;
    }
    this.measuring = true;
    cx.spawn(async (cx) => {
      const out = { key, at: 0, base: null, add: 0, del: 0, files: 0, error: null };
      try {
        // The root of a folder does not move: a success is kept, a failure retries next tick.
        this.tops ??= new Map();
        let root = this.tops.get(key);
        if (!root) {
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: at.cwd, on: at.on });
          if (top.code !== 0) throw new Error((top.stderr || "not a git repository").trim());
          root = top.stdout.trim();
          this.tops.set(key, root);
        }
        // One call lists all four candidate refs; the same priority decides which one is the base.
        const refs = await exec("git", ["for-each-ref", "--format=%(refname:short)",
          "refs/heads/main", "refs/heads/master", "refs/remotes/origin/main", "refs/remotes/origin/master"], { cwd: root, on: at.on });
        if (refs.code === 0) {
          const have = new Set(String(refs.stdout ?? "").split("\n").map((line) => line.trim()).filter(Boolean));
          out.base = BASE_REFS.find((ref) => have.has(ref)) ?? null;
        }
        if (out.base) {
          const diff = await exec("git", [...READ, "diff", "--numstat", "-z", "--no-renames", out.base], { cwd: root, on: at.on });
          if (diff.code !== 0) throw new Error((diff.stderr || "git diff failed").trim());
          for (const entry of diff.stdout.split("\0")) {
            if (!entry) continue;
            const [add, del] = entry.split("\t");
            out.files += 1;
            out.add += Number(add) || 0;
            out.del += Number(del) || 0;
          }
        }
      } catch (e) { out.error = String(e?.message ?? e); }
      out.at = Date.now();
      this.diff = out;
      this.measuring = false;
      cx.notify();
    });
  }

  // The Changes button, with what the branch says: the base it is compared with and git's
  // additions and deletions. It opens the same Changes panel; the numbers never replace it.
  changesButton(panel, body, t, diff) {
    const on = panel && !panel.hidden && body?.active === "changes";
    const base = diff?.base ?? null;
    // The panel name stays the name; the branch and the numbers are read as a caption.
    const against = !diff ? "vs origin/main" : base ? `vs ${base}` : "";
    const tip = diff?.error
      ? `Changes: ${diff.error}`
      : base
        ? `${diff.files} file${diff.files === 1 ? "" : "s"} vs ${base} · +${diff.add} −${diff.del} (tracked changes, working tree)`
        : "Changes: origin/main not found";
    return h_flex().id("panel-changes").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12.5).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); }
      })
      .child(svg("mods/changes/changes.svg").size(14))
      .child(div().child("Changes"))
      .when(Boolean(against), (el) => el.child(div().text_size(12).text_color(t.muted).child(against)))
      .when(Boolean(base), (el) => el
        .child(div().text_size(12.5).font_medium().text_color(diff.add > 0 ? t.ansi2 : t.muted).child(`+${diff.add}`))
        .child(div().text_size(12.5).font_medium().text_color(diff.del > 0 ? t.ansi1 : t.muted).child(`−${diff.del}`)));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (open on Issues if it never had one — only an explicit close keeps it
  // shut), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !Object.hasOwn(this.panels, space.id))) {
        const stored = Object.hasOwn(this.panels, space.id) ? this.panels[space.id] : "gh-git";
        const want = stored === null ? null : enabled.includes(stored) ? stored : "gh-git";
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    try { localStorage.setItem("panels", JSON.stringify(this.panels)); } catch { /* memory only */ }
  }

  // The wall's chip at the tab strip's right end, in two halves that each open a wall: the
  // agents `agent-wall` would put side by side (every agent, or the set a drag composed),
  // and the ones working or blocked now. The wall builds, writes and remembers; this only
  // draws and sends that mod its own command, so a click and `ctrl-shift-g` take one path.
  wallChip(t) {
    const on = Boolean(shared("agent-wall.on"));
    const mode = shared("agent-wall.mode") ?? null;
    // What the left half opens: unchanged from before this half existed — the agents a
    // gesture picked, and every agent when that leaves fewer than two.
    const chosen = Array.isArray(shared("agent-wall.list")) ? [...new Set(shared("agent-wall.list"))] : [];
    const by = new Map(agents().map((a) => [a.address, a]));
    const kept = chosen.filter((address) => by.has(address));
    const list = kept.length >= 2 ? kept.map((address) => by.get(address)) : agents();
    // What the right half opens: working or blocked right now. Counted live and never
    // frozen — the frozen set is the wall's own, and this half must not promise it.
    const active = agents().filter((a) => a.status === "working" || a.status === "blocked");
    const blocked = active.some((a) => a.status === "blocked");
    const allOn = on && mode !== "active";
    const actOn = on && mode === "active";
    const name = (a) => `\u00b7 ${plain(a.space_name) || plain(a.program?.name) || "agent"} \u00b7 ${a.status ?? "idle"}`;
    const allWhy = allOn ? "click to return to tabs"
      : list.length >= 2 ? (actOn ? "click to show every agent" : "click to show them")
        : list.length === 1 ? "needs two agents \u2014 one is running" : "needs two agents \u2014 no agent is running";
    const allTip = [`Wall: ${list.length || "no"} agent${list.length === 1 ? "" : "s"} side by side \u2014 ${allWhy}`,
      ...list.map(name)].join("\n");
    const actWhy = actOn ? "click to return to tabs"
      : active.length >= 2 ? "click to show them"
        : active.length === 1 ? "needs two active agents \u2014 one is working" : "needs two active agents \u2014 none is working";
    const actTip = [`Active wall: ${active.length || "no"} working or blocked \u2014 ${actWhy}`,
      ...active.map(name)].join("\n");
    const allLive = allOn || list.length >= 2;
    const actLive = actOn || active.length >= 2;
    const half = (id, tip, live, showing, action, children) => h_flex().id(id).h(24).px(5).gap(5).items_center().rounded(5)
      .tooltip(tip)
      .when(showing, (el) => el.bg(t.chrome))
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); action(); }))
      .children(children);
    return h_flex().id("wall-chip-button").h(26).flex_none().px(2).gap(1).items_center().rounded(6)
      .bg(on ? t.selected : t.chrome)
      .border(1).border_color(on ? t.accent : t.chrome)
      .child(half("wall-all", allTip, allLive, allOn, () => run("agent-wall.all"), [
        svg("mods/agent-wall/wall.svg").size(13).text_color(on ? t.accent : t.muted),
        div().text_size(11.5).text_color(allOn ? t.foreground : t.muted).child(String(list.length)),
      ]))
      .child(div().w(1).h(14).flex_none().bg(t.border))
      .child(half("wall-active", actTip, actLive, actOn, () => run("agent-wall.active"), [
        div().size(7).flex_none().rounded(4).bg(active.length ? (blocked ? t.blocked : t.working) : t.dim)
          .when(actOn, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 })),
        div().text_size(11.5).text_color(actOn ? t.foreground : t.muted).child(`${active.length} active`),
      ]));
  }

  render(cx) {
    const t = theme();
    // One location walk per render: the measurement and the diff guard read the same one.
    const at = location();
    this.measureDiff(cx, at);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    // One pane scan per render: per tab, an agent's pane wins, then the focused one, then any.
    const paneByTab = new Map();
    for (const p of panes()) {
      const prev = paneByTab.get(p.tab);
      if (!prev
        || (!prev.program?.agent && p.program?.agent)
        || (!prev.program?.agent && !prev.focused && p.focused)) paneByTab.set(p.tab, p);
    }
    const item = (c, i) => {
      const program = paneByTab.get(c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          // A drag reorders; it is not a pick of a place, so the wall stays.
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else {
            // A tab is a place, and the wall is a view of the world, not a place to work:
            // picking one leaves the wall for it. The wall's own tick cannot see a pick of
            // the tab already shown, so the click asks for the exit first.
            if (shared("agent-wall.on")) run("agent-wall.off");
            run("tab.select", { id: c.id });
          }
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel");
    // `panel-body` is a child of `panel`: one walk, not two over the whole layout.
    const body = panel ? find(panel, "panel-body") : null;
    const raw = shared("workspace.panels");
    const bases = Array.isArray(raw) ? raw.filter((name) => typeof name === "string") : ["files", "changes"];
    // Only what the stack actually holds: a name remembered from an older layout (a panel
    // that has since moved inside another, like gh-board) is never offered nor asked for —
    // `layout.select` would fail with no such child.
    const there = (body?.children ?? []).filter((node) => node?.content?.mod).map((node) => node.id);
    const known = there.length ? there : ["files", "changes", "gh-git"];
    const enabled = [...new Set([...bases, "gh-git"])].filter((id) => known.includes(id));
    this.syncPanel(space, panel, body, enabled);
    // The measurement is for one folder: a result that arrived for another is not shown.
    const diff = this.diff && this.diff.key === locationKey(at) ? this.diff : null;
    // A panel button: one stack child, optionally opening it on one of its sections.
    // One button per panel in the stack: the sections inside a panel are its own tabs.
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12.5).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar()
        .children(shown.map(item))
        .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu-pinned", kind: "popup", width: 250, height: 512 }))))
      .child(this.wallChip(t))
      .when(enabled.includes("changes"), el => el.child(this.changesButton(panel, body, t, diff)))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      // gh-git: worktrees, the commit graph and the issues, one panel with three sections.
      .when(enabled.includes("gh-git"), el => el.child(panelButton("gh-git", "Git", "mods/gh-git/branch.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-gh/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-gh/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-gh/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
