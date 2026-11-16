import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, shared, setShared, layout } from "herdr";

// The per-space panel choice, as this mod last wrote it — anything else is ignored,
// because a value this mod cannot read must not take the whole right column down.
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

// The folder these tools speak about: the focused pane's, else the active space's. The same
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

export default class Tools extends View {
  init(_props, cx) {
    this.panels = panels();
    this.diff = null; // { key, at, base, add, del, files, error }
    this.measuring = false;
    this.measureDiff(cx);
    cx.timer.every(10000, (cx) => this.measureDiff(cx));
  }

  // "Changes vs origin/main" in the tools: git's own addition and deletion counts, not a
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
      // The pane header's Changes button shows the same numbers. Only a real change is
      // written: the 10s clock must not redraw the window for nothing.
      const prev = shared("tabs-gh.diff");
      if (!prev || prev.key !== out.key || prev.base !== out.base || prev.add !== out.add
        || prev.del !== out.del || prev.files !== out.files || prev.error !== out.error) {
        setShared("tabs-gh.diff", out);
      }
      this.measuring = false;
      cx.notify();
    });
  }

  // The Changes button, with what the branch says: the base it is compared with and git's
  // additions and deletions. It opens the same Changes panel; the numbers never replace it.
  changesButton(panel, body, t, diff) {
    const on = panel && !panel.hidden && body?.active === "changes";
    const base = diff?.base ?? null;
    const tip = diff?.error
      ? `Changes: ${diff.error}`
      : base
        ? `${diff.files} file${diff.files === 1 ? "" : "s"} vs ${base} · +${diff.add} −${diff.del} (tracked changes, working tree)`
        : "Changes: origin/main not found";
    return h_flex().id("panel-changes").h(24).px(6).gap(4).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .hover(s => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(() => {
        if (on) run("layout.hide", { id: "panel" });
        else { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); }
      })
      .child(svg("mods/changes/changes.svg").size(13))
      .child(div().child("Changes"))
      .when(Boolean(base), (el) => el
        .child(div().text_size(12).font_medium().text_color(diff.add > 0 ? t.ansi2 : t.muted).child(`+${diff.add}`))
        .child(div().text_size(12).font_medium().text_color(diff.del > 0 ? t.ansi1 : t.muted).child(`−${diff.del}`)));
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

  render(cx) {
    const t = theme();
    // One location walk per render: the measurement and the diff guard read the same one.
    const at = location();
    this.measureDiff(cx, at);
    const space = spaces().find(p => p.active);
    const stop = (_e, cx) => cx.stop_propagation();
    const root = layout();
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
      return h_flex().id(`panel-${id}`).h(24).px(6).gap(4).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(13)).child(label);
    };
    // The right column's top row: the controls the agent header used to carry.
    return h_flex().size_full().px(8).gap(4).items_center().justify_end().bg(t.chrome)
      .when(enabled.includes("changes"), el => el.child(this.changesButton(panel, body, t, diff)))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      // gh-git: worktrees, the commit graph and the issues, one panel with three sections.
      .when(enabled.includes("gh-git"), el => el.child(panelButton("gh-git", "Git", "mods/gh-git/branch.svg")));
  }
}
