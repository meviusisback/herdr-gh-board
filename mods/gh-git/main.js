import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, focused, home, layout, nextCommand, notify, panes, settings, shared, setShared, spaces, theme, run, window } from "herdr";
import Issues from "./issues.js";
import { tint, initials, text, relativeEpoch, splitSubject, parseLog, parseStats, layoutLanes, atKey } from "./format.js";
import * as fs from "fs/promises";

// One panel for git: "Trees" (every checkout of every repo under the repos folder Settings
// names, the active space's highlighted; a click jumps to its space), "Commits" (the commit
// graph of the active space's repo) and "Issues" (open issues and PRs of the picked repos,
// with their conversations — issues.js). One panel with a switch, so the views share a
// header and a timer; the view is kept in shared state, so the tab bar and a restart find
// it again.
const REFRESH_MS = 15000;
const MAX_COMMITS = 200;
// How many of the newest commits we ask the size of: enough for what is on screen, cheap
// enough to ask on every refresh.
const STAT_COMMITS = 50;

const VIEWS = [
  { id: "trees", label: "Trees", icon: "mods/gh-git/branch.svg" },
  { id: "commits", label: "Commits", icon: "mods/gh-git/history.svg" },
  { id: "issues", label: "Issues", icon: "mods/gh-git/inbox.svg" },
];

// git log --graph draws lanes in these seven colors, in this order.
const LANES = ["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6", "ansi3"];

// The graph is drawn, not typed: one lane every 16px, each commit row 34px tall, so a
// line meets the next row's line and the dot always sits in the middle of its own.
const SLOT = 16;
const ROW_H = 46;

const toneOf = (t, j) => t[LANES[j % LANES.length]] ?? t.dim;

const TYPES = { feat: "ansi2", fix: "ansi1", chore: "muted", docs: "ansi4", refactor: "ansi5", test: "ansi6", perf: "ansi3", style: "ansi3", build: "ansi4" };

// The folder the center works in — the active space's folder, else the
// focused pane's cwd — and the machine it lives on, so a space on another
// machine is read there rather than at a same-named path here.
function activeAt() {
  const space = spaces().find((s) => s.active);
  if (space?.folder) return { folder: space.folder, on: space.machine ?? null };
  const folder = focused()?.cwd ?? panes().find((p) => p.focused)?.cwd ?? null;
  return { folder, on: space?.machine ?? null };
}

// Whether the layout is drawing this panel right now: another child of a stack keeps a copy
// alive, and so does a hidden column, but neither is what the person is reading — and the
// GitHub hour is not spent on it.
function shownNow() {
  const walk = (node, hidden) => {
    if (!node) return false;
    const shut = hidden || Boolean(node.hidden);
    if (node.type === "stack") {
      const active = (node.children ?? []).find((child) => child.id === node.active);
      return walk(active, shut);
    }
    if (node.content?.mod === "gh-git") return !shut;
    return (node.children ?? []).some((child) => walk(child, shut));
  };
  return walk(layout(), false);
}

// Read-only git with the checkout's own settings neutralised: a repository can carry a
// core.fsmonitor command or a log signature program, and neither may run on a scan.
const GIT = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];
const gitAt = (dir, on, ...args) => exec("git", [...GIT, "-C", dir, ...args], on ? { on } : {});

// Every checkout of every repo under a folder: one row per worktree.
// What a worktree row shows besides its name: what is waiting in it and its last commit.
// Two git calls per checkout, run while the list is being built, so the view stays cheap.
async function treeFacts(path, on) {
  const facts = { changes: 0, ahead: 0, behind: 0, hash: "", subject: "", author: "", at: 0, when: "" };
  try {
    const st = await gitAt(path, on, "status", "--porcelain=v2", "--branch");
    if (st.code === 0) {
      for (const line of st.stdout.split("\n")) {
        if (line.startsWith("# branch.ab ")) {
          const found = /\+(\d+) -(\d+)/.exec(line);
          facts.ahead = Number(found?.[1]) || 0;
          facts.behind = Number(found?.[2]) || 0;
        } else if (line && !line.startsWith("#")) facts.changes++;
      }
    }
  } catch { /* a worktree whose folder is gone */ }
  try {
    const r = await gitAt(path, on, "log", "-1", "--format=%H%x1f%at%x1f%aN%x1f%s");
    if (r.code === 0) {
      const [hash = "", at = "", author = "", subject = ""] = r.stdout.trim().split("\x1f");
      facts.hash = text(hash);
      facts.at = Number(at) || 0;
      facts.author = text(author);
      facts.subject = text(subject);
      facts.when = relativeEpoch(at);
    }
  } catch { /* no commits yet */ }
  return facts;
}

// The folder repos live in, as Settings (mods/settings) keeps it: ~ is the home folder.
function reposRoot() {
  const chosen = shared("repos.root");
  const path = (typeof chosen === "string" && chosen.trim() ? chosen.trim() : `${home()}/repo`)
    .replace(/^~(?=$|\/)/, home())
    .replace(/\/+$/, "");
  // Only a plain absolute path: a value planted in shared state must not climb anywhere.
  if (path === "/" || !path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) return `${home()}/repo`;
  return path;
}

async function scanRepos(root) {
  // The repos folder is this computer's: Trees lists local checkouts, the Commits
  // view is the one that follows the active space to its own machine.
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const dir = `${root}/${e}`;
    try {
      // A checkout has a .git entry (a directory, or a file for a worktree). Without it, git
      // would walk up to an enclosing repo and report that repo's worktrees as this folder's.
      if (!(await fs.exists(`${dir}/.git`))) continue;
      const r = await gitAt(dir, null, "worktree", "list", "--porcelain");
      if (r.code !== 0) continue;
      const trees = [];
      let cur = null;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: "", bare: false }; trees.push(cur); }
        else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
        else if (cur && line.startsWith("bare")) cur.bare = true;
        else if (cur && line.startsWith("detached")) cur.branch = "(detached)";
      }
      if (!trees.length) continue;
      // The main checkout leads, the rest follow by branch: a stable order for the rows.
      trees.sort((a, b) => (a.path === dir ? -1 : 0) - (b.path === dir ? -1 : 0) || String(a.branch).localeCompare(String(b.branch)));
      // Six at a time: each checkout costs two git calls, and a repo's checkouts are disjoint.
      const live = trees.filter((w) => !w.bare);
      let next = 0;
      const worker = async () => {
        for (;;) {
          const index = next++;
          if (index >= live.length) return;
          Object.assign(live[index], await treeFacts(live[index].path, null));
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, live.length) }, worker));
      out.push({ dir, name: e, trees });
    } catch { /* not a checkout */ }
  }
  return out;
}

const VIEW = "gh-git.view";

export default class GhGit extends View {
  init(props, cx) {
    this.props = props ?? {};
    const saved = shared(VIEW);
    this.view = VIEWS.some((v) => v.id === saved) ? saved : "commits";
    this.width = 900;
    this.height = 900;
    this.issues = null;
    // Commits
    this.rows = [];
    this.stats = {}; // hash -> { files, adds, dels }, the newest commits only
    this.remotes = []; // the names of the servers this repo knows, so refs can be read out
    this.folder = null;
    this.at = ""; // machine|folder the rows were read from
    this.wasHidden = false;
    this.error = null;
    this.loading = true;
    this.busy = false;
    // Trees
    this.repos = [];
    this.treesLoading = true;
    this.treesBusy = false;
    if (this.view === "issues") this.issuesView(cx);
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
    // Keys can switch the view: `gh-git.trees`, `gh-git.commits`, `gh-git.refresh`.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "refresh") this.refresh(cx);
        else if (VIEWS.some((v) => v.id === command)) this.setView(command, cx);
      }
    });
  }

  // The Issues section: started the first time it is shown, so a panel on Trees or
  // Commits asks GitHub nothing.
  issuesView(cx) {
    if (!this.issues) {
      this.issues = new Issues(this);
      this.issues.start(cx);
    }
    return this.issues;
  }

  // Whether the layout draws this panel (issues.js asks its host, and skips its batch).
  shown() {
    return shownNow();
  }

  // One timer for whichever view is shown: the hidden one is not read at all.
  refresh(cx) {
    // A panel behind another stack child, or under a hidden column, is not on screen: the
    // GitHub hour is the person's, and this copy waits until it is shown again.
    if (!shownNow()) { this.wasHidden = true; return; }
    this.wasHidden = false;
    if (this.view === "commits") this.refreshCommits(cx);
    else if (this.view === "trees") this.refreshTrees(cx);
    else this.issuesView(cx).refresh(cx);
  }

  setView(view, cx) {
    if (view === this.view) return;
    const known = VIEWS.some((v) => v.id === view);
    this.view = known ? view : "commits";
    setShared(VIEW, this.view);
    if (this.view === "issues") this.issuesView(cx);
    this.refresh(cx);
    cx.notify();
  }

  refreshCommits(cx) {
    const { folder, on } = activeAt();
    const key = atKey({ folder, on });
    let dirty = false;
    if (key !== this.at) {
      // Another repo, or another machine's path: drop the old graph at once, don't show it stale.
      this.at = key;
      this.folder = folder;
      this.rows = [];
      this.stats = {};
      this.logText = "";
      this.statsSig = "";
      this.remotesAt = 0;
      this.remotesAtKey = "";
      this.error = null;
      this.loading = true;
      dirty = true;
      cx.notify();
    }
    if (!folder) { this.loading = false; cx.notify(); return; }
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await gitAt(folder, on, "log",
          "--format=%H%x1f%P%x1f%aN%x1f%at%x1f%D%x1f%s%x1e", "-n", String(MAX_COMMITS), "--all", "--topo-order");
        if (r.code !== 0) {
          const err = (r.stderr || "").trim().split("\n").pop() || "";
          if (/not a git repository|not a working tree/i.test((r.stderr || "") + (r.stdout || ""))) {
            this.rows = [];
            this.error = "Not a git checkout";
          } else {
            throw new Error(err || "git log failed");
          }
          this.logText = "";
          dirty = true;
        } else {
          // A history that did not change is the same rows: parse nothing, and redraw nothing.
          const out = r.stdout;
          if (out !== this.logText) {
            this.logText = out;
            this.rows = layoutLanes(parseLog(out)).rows;
            this.error = this.rows.length ? null : "No commits yet";
            dirty = true;
          }
          // How big the newest changes were, so a tooltip can say it without asking git while
          // the pointer waits. Only asked when the newest commits move: a hash's numbers never
          // change, and a merge has none (git does not diff one by default).
          const sig = this.rows.slice(0, STAT_COMMITS).map((row) => row.commit.hash).join(",");
          if (sig !== this.statsSig) {
            const stat = await gitAt(folder, on, "log", "--format=%H", "--shortstat", "-n", String(STAT_COMMITS), "--all", "--topo-order").catch(() => null);
            // The signature is recorded only once the numbers are in: a failed read must be
            // asked again on the next poll, not remembered as answered.
            if (stat && stat.code === 0) {
              this.statsSig = sig;
              this.stats = { ...(this.stats ?? {}), ...parseStats(stat.stdout) };
              dirty = true;
            }
          }
          // Which names are servers, so `origin/main` reads as the copy on a server and
          // `feat/x` as a line of work of its own. Remotes change rarely: ask every 5 minutes.
          if (key !== this.remotesAtKey || Date.now() - (this.remotesAt ?? 0) > 300000) {
            const remotes = await gitAt(folder, on, "remote").catch(() => null);
            const list = remotes && remotes.code === 0
              ? String(remotes.stdout ?? "").split("\n").map((name) => name.trim()).filter(Boolean)
              : [];
            this.remotesAt = Date.now();
            this.remotesAtKey = key;
            if (list.join("\n") !== (this.remotes ?? []).join("\n")) { this.remotes = list; dirty = true; }
          }
        }
      } catch (e) {
        this.rows = [];
        this.error = String(e?.message || e);
        // The next successful read must rebuild the rows and clear the error, even when the
        // history did not change while the read was failing.
        this.logText = "";
        this.statsSig = "";
        dirty = true;
      } finally {
        this.busy = false;
        this.loading = false;
        if (dirty) cx.notify();
      }
    });
  }

  refreshTrees(cx) {
    if (this.treesBusy) return;
    this.treesBusy = true;
    cx.spawn(async (cx) => {
      try {
        this.repos = await scanRepos(reposRoot());
      } finally {
        this.treesBusy = false;
        this.treesLoading = false;
        cx.notify();
      }
    });
  }

  // The space showing this folder (a worktree space), else the main checkout's
  // own space if the folder is a main checkout shown somewhere.
  openTree(path, name, qualifier) {
    const space = spaces().find((s) => s.folder === path);
    if (space) { run("space.select", { id: space.id }); return; }
    // Never a second space with the same name (gh-new guards the same way).
    let fresh = name;
    if (qualifier && spaces().some((s) => s.name === fresh)) fresh = `${name} · ${qualifier}`;
    if (spaces().some((s) => s.name === fresh)) fresh = `${name} · ${path}`;
    run("space.new", { name: fresh, folder: path, machine: "" });
  }

  // A repo as a group: its own colour, a hairline to the right, its worktrees hanging off the
  // line below it — the same drawing language as the graph in the Commits view.
  repoHeader(repo, count, color, t) {
    return h_flex().h(32).flex_none().items_center().gap(7).px(7).pt(6)
      .child(div().relative().w(14).h_full().flex_none()
        .child(div().absolute().left(6).top(16).w(2).h_full().rounded_full().bg(tint(color, "4d")))
        .child(h_flex().absolute().left(0).top(6).w(14).h(14).items_center().justify_center()
          .child(svg("mods/gh-git/repo.svg").size(13).flex_none().text_color(color))))
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(text(repo.name)))
      .child(div().flex_none().text_size(11.5).text_color(t.muted).child(`${count} worktree${count === 1 ? "" : "s"}`))
      .child(div().flex_1().h(1).bg(t.border));
  }

  // One worktree as a card on its repo's line: the checkout, what it holds, and its last
  // commit below in the same two-line shape as a commit row.
  treeRow(repo, wt, t, current, color, mono) {
    const main = wt.path === repo.dir;
    // The primary checkout is "main" only while it holds the repo's main line. On another
    // branch it says that branch: its own worktree on `main` would otherwise be a second
    // row reading "main", with only one of them on it.
    const branch = wt.branch && wt.branch !== "(detached)" ? wt.branch : "";
    const onMainLine = branch === "main" || branch === "master";
    const label = main
      ? (branch && !onMainLine ? text(branch) : "main")
      : text(wt.path.split("/").filter(Boolean).pop());
    const on = current === wt.path;
    const chips = [];
    if (wt.changes) chips.push(this.chip(`● ${wt.changes}`, t.ansi3, `${wt.changes} uncommitted file${wt.changes === 1 ? "" : "s"} here`));
    if (wt.ahead) chips.push(this.chip(`↑${wt.ahead}`, t.ansi2, `${wt.ahead} commit${wt.ahead === 1 ? "" : "s"} not pushed to the upstream branch`));
    if (wt.behind) chips.push(this.chip(`↓${wt.behind}`, t.ansi1, `${wt.behind} commit${wt.behind === 1 ? "" : "s"} upstream that this checkout does not have`));
    return h_flex().id(`ghg-t-${wt.path}`).h(44).flex_none().gap(9).items_center().px(6).rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .tooltip(`${text(wt.path)}\n${main ? "the main checkout" : "a worktree"}${wt.branch ? ` · ${text(wt.branch)}` : ""}`
        + `${on ? " · shown in the active space" : ""}${wt.author ? `\nlast commit by ${text(wt.author)}` : ""}`)
      .on_click(() => this.openTree(wt.path, main ? repo.name : label, main ? "checkout" : repo.name))
      .child(div().relative().w(14).h_full().flex_none()
        .child(div().absolute().left(6).top(0).w(2).h_full().rounded_full().bg(tint(color, "4d")))
        .child(div().absolute().left(3).top(main ? 4 : 5).w(8).h(8).rounded(2.5).bg(tint(color, "22"))
          .border_1().border_color(tint(color, "aa"))
          .child(div().absolute().left(2).top(2).w(4).h(4).rounded(1.5)
            .bg(wt.changes ? t.ansi3 : on ? t.accent : tint(color, "dd")))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(5).items_center().min_w(0)
          .child(div().min_w(0).truncate().text_size(13).font_medium().text_color(on ? t.foreground : t.muted).child(label))
          .when(!main && Boolean(wt.branch) && wt.branch !== label, (e) => e.child(this.refPill(text(wt.branch), t)))
          .when(on, (e) => e.child(h_flex().h(17).px(5).flex_none().items_center().rounded(5)
            .bg(tint(t.accent, "26")).border_1().border_color(tint(t.accent, "66"))
            .tooltip("The active space works in this checkout")
            .child(div().text_size(11).font_medium().text_color(t.accent).child("here"))))
          .child(div().flex_1())
          .children(chips))
        .when(Boolean(wt.subject), (e) => e.child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().font_family(mono).text_size(11).text_color(tint(t.ansi3, "bb")).child(wt.hash.slice(0, 7)))
          .child(div().flex_1().min_w(0).child(this.subject({ subject: wt.subject }, t, false)))
          .child(div().flex_none().font_family(mono).text_size(11).text_color(t.muted).child(wt.when)))));
  }

  // A small count in a tint, the same pill family as a ref: what is waiting in a checkout.
  chip(label, color, tip) {
    return h_flex().h(17).px(5).flex_none().items_center().rounded(5)
      .bg(tint(color, "1c")).border_1().border_color(tint(color, "4d")).tooltip(tip)
      .child(div().text_size(11).font_medium().text_color(color).child(label));
  }

  // The graph, drawn rather than typed: one vertical line per lane, a rounded elbow where
  // a lane starts or ends, and a dot on the commit's own. Absolute children in a fixed box,
  // so a line meets the next row's line with no character cell in between.
  // How wide the graph may be: a quiet history gets roomy lanes, a busy one tightens them
  // instead of pushing the subject off the panel.
  geometry() {
    // One width for the whole list, from the busiest row: every subject starts at the same
    // x, and a history with many lanes tightens them instead of eating the panel.
    const n = Math.max(...(this.rows.length ? this.rows.map((row) => row.cells.length) : [1]), 1);
    const slot = n <= 4 ? SLOT : Math.max(7, Math.round(64 / n));
    const dot = slot >= 12 ? 7 : slot >= 9 ? 5 : 4;
    const halo = dot + (slot >= 12 ? 7 : 5);
    return { n, slot, dot, halo, width: n * slot };
  }

  graph(row, t, geo) {
    const { cells, joins, forks, lane } = row;
    const merge = row.commit.parents.length > 1;
    const { slot, dot: dotSize, halo, width } = geo;
    const mid = ROW_H / 2;
    const centre = (j) => j * slot + slot / 2;
    const bars = [];
    const vertical = (j, y, h, alpha) => bars.push(div().absolute().left(centre(j) - 1).top(y).w(2).h(h)
      .rounded_full().bg(tint(toneOf(t, j), alpha)));
    const cross = (a, b, alpha) => bars.push(div().absolute()
      .left(Math.min(centre(a), centre(b))).top(mid - 1).w(Math.abs(centre(a) - centre(b))).h(2)
      .rounded_full().bg(tint(toneOf(t, b), alpha)));

    for (let j = 0; j < cells.length; j++) {
      if (cells[j] === "node") continue;
      // pass: another branch's lane goes by; fork/join: this lane exists only on one side of
      // the row, because it is born or dies in this commit.
      if (cells[j] === "pass") vertical(j, 0, ROW_H, "55");
      else if (forks.includes(j)) vertical(j, mid, ROW_H - mid, "cc");
      else if (joins.includes(j)) vertical(j, 0, mid, "cc");
    }
    for (const target of [...forks, ...joins]) cross(lane, target, "aa");
    // The node's own lane: full height only where the commit continues on that side.
    vertical(lane, 0, ROW_H, "66");

    const ring = merge ? halo + 2 : halo;
    const dot = merge ? dotSize + 2 : dotSize;
    const node = div().absolute().left(centre(lane) - ring / 2).top(mid - ring / 2).w(ring).h(ring)
      .rounded_full().bg(tint(toneOf(t, lane), "22")).border(1).border_color(tint(toneOf(t, lane), "99"))
      .child(div().absolute().left((ring - dot) / 2).top((ring - dot) / 2).w(dot).h(dot)
        .rounded_full().bg(toneOf(t, lane)));

    const shape = this.graphTip(row);
    return div().relative().w(width).h(ROW_H).flex_none().tooltip(shape).children([...bars, node]);
  }

  // What each name pointing at this change means, for someone who has never used git.
  refTip(ref) {
    const name = String(ref ?? "");
    const remotes = Array.isArray(this.remotes) ? this.remotes : [];
    // The server a name belongs to, if any: `origin/main` is origin's, `feat/x` nobody's.
    const serverOf = (value) => remotes.find((remote) => value === remote || value.startsWith(`${remote}/`)) ?? null;
    const server = serverOf(name);
    const arrow = name.indexOf(" -> ");
    if (arrow > 0) {
      const left = name.slice(0, arrow).trim();
      const right = name.slice(arrow + 4).trim();
      if (serverOf(left)) return `The line of work the server "${serverOf(left)}" treats as its base — the one someone gets when they clone the project.`;
      return `You are here. The newest change on "${right}" — the line of work open in your folder right now.`;
    }
    if (name === "HEAD") return 'You are here, but not on a named line of work: an older change is shown directly (a "detached" state).';
    if (name.startsWith("tag:")) {
      return `A bookmark called "${name.replace(/^tag:\s*/, "").trim()}", pinned to this change and never moving — usually how a release is marked.`;
    }
    if (server && name === `${server}/HEAD`) return `The line of work the server "${server}" treats as its base — the one someone gets when they clone the project.`;
    if (server) return `"${name}" is where that line of work stood on the server "${server}" the last time it was uploaded.`;
    if (name === "main" || name === "master") return `The base line of work ("${name}"): everything starts from it and comes back to it.`;
    return `A line of work called "${name}". A name that points at a change and moves forward as new changes are saved.`;
  }

  // How big the change was, in words: the numbers git printed for it, if it is one of the
  // newest ones we asked about.
  sizeTip(hash) {
    const stat = hash ? this.stats?.[hash] : null;
    if (!stat) return "";
    const parts = [];
    if (stat.files) parts.push(`${stat.files} file${stat.files === 1 ? "" : "s"}`);
    if (stat.adds) parts.push(`${stat.adds} line${stat.adds === 1 ? "" : "s"} added`);
    if (stat.dels) parts.push(`${stat.dels} removed`);
    return parts.length ? `Size: ${parts.join(", ")}.` : "";
  }

  subjectTip(commit, merge) {
    if (merge) return "A merge: it brings another line of work into this one. Git writes this message itself, so it rarely says more.";
    const size = this.sizeTip(commit?.hash);
    return `What this change did, in the author's own words.${size ? `\n${size}` : ""}`;
  }

  graphTip(row) {
    return row.commit.parents.length > 1
      ? "The dot is this change. It joins two lines of work into one, which is why the history splits below it."
      : "The dot is this change. Coloured lines passing by are other lines of work; a line that starts or ends here means one was branched off this change or merged into it.";
  }

  // A ref as a small pill: HEAD first (it is where the work is), a tag, then branches.
  refPill(ref, t) {
    const head = ref.startsWith("HEAD");
    const tag = ref.startsWith("tag:");
    const color = head ? t.accent : tag ? t.ansi3 : t.ansi6;
    return h_flex().h(17).px(5).flex_none().items_center().rounded(5)
      .bg(tint(color, "1c")).border(1).border_color(tint(color, "5c")).tooltip(this.refTip(ref))
      .child(div().text_size(10.5).font_medium().text_color(color).child(ref.replace(/^tag:\s*/, "")));
  }

  // Who wrote it: initials on a tint, so an author reads at a glance and the row stays short.
  avatar(name, t) {
    const palette = [t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi2];
    let hash = 0;
    for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
    const color = palette[hash % palette.length];
    return div().size(14).flex_none().rounded_full().flex().items_center().justify_center()
      .bg(tint(color, "2b")).border(1).border_color(tint(color, "66")).tooltip(`Saved by ${name} — the person (or bot) who wrote this change.`)
      .child(div().text_size(10.5).font_semibold().text_color(color).child(initials(name)));
  }

  // "today", "yesterday", else the date: the list reads as a timeline, not a wall of rows.
  dayLabel(epoch) {
    if (!epoch) return "";
    const day = new Date(epoch * 1000);
    const today = new Date();
    const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((midnight(today) - midnight(day)) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days} days ago`;
    return day.toLocaleDateString(undefined, { day: "numeric", month: "short", year: day.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  }

  // A click puts the full hash on the clipboard: the one thing a graph is usually read for.
  copyHash(hash, cx) {
    // A hash is hex and nothing else: never a word a shell or a script could read twice.
    if (!/^[0-9a-f]{7,40}$/i.test(String(hash ?? ""))) return;
    cx.spawn(async () => {
      try {
        const platform = window()?.platform;
        const [cmd, args] = platform === "macos" ? ["osascript", ["-e", `set the clipboard to "${hash}"`]]
          : platform === "windows" ? ["powershell", ["-NoProfile", "-Command", `Set-Clipboard -Value "${hash}"`]]
          : ["wl-copy", ["--", hash]];
        await exec(cmd, args);
        notify({ title: "Commit", body: `${hash.slice(0, 7)} copied to the clipboard` });
      } catch (e) {
        notify({ title: "Commit", body: String(e?.message ?? e), level: "error" });
      }
    });
  }

  // The subject, with its kind in front: a coloured `type(scope):` where the project uses
  // one, the words after it in the row's own colour.
  subject(commit, t, merge, tip) {
    const parts = splitSubject(commit.subject);
    const color = parts ? (t[TYPES[parts.type]] ?? t.muted) : null;
    const shown = (el) => el.when(Boolean(tip), (e) => e.tooltip(tip));
    if (!parts) return shown(div().min_w(0).truncate().text_size(13).text_color(merge ? t.muted : t.foreground)).child(commit.subject);
    return shown(h_flex().min_w(0).items_baseline())
      .child(div().flex_none().text_size(12).font_semibold().text_color(color).child(`${parts.type}${parts.scope}:`))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(merge ? t.muted : t.foreground).child(` ${parts.text}`));
  }

  dayRow(day, count, index, t) {
    return h_flex().id(`ghg-day-${index}`).h(index ? 26 : 20).flex_none().items_center().gap(7).px(6)
      .when(index > 0, (e) => e.pt(8))
      .child(div().flex_none().text_size(11.5).font_semibold().text_color(t.muted).child(day.toUpperCase()))
      .child(div().flex_none().text_size(11).text_color(t.muted).child(`${count}`))
      .child(div().flex_1().h(1).bg(t.border));
  }

  // Two lines a commit: what it says, then who and when, with its refs on the right of the
  // subject. Tall enough that the graph's dot and its line have room to breathe.
  graphRow(row, t, mono, geo) {
    const c = row.commit;
    const merge = c.parents.length > 1;
    // One ref on the second line, the rest counted: the subject keeps the first line to itself.
    const refs = c.refs.slice(0, 1);
    const more = c.refs.length - refs.length;
    return h_flex().id(`ghc-${c.hash.slice(0, 7)}`).h(ROW_H).flex_none().gap(9).items_center().px(6).rounded(8)
      .cursor_pointer().on_click((_e, cx) => this.copyHash(c.hash, cx))
      .hover((s) => s.bg(t.hover))
      .tooltip("One saved change: what it says, who saved it, when, and the names that point at it. Click to copy its ID.")
      .child(this.graph(row, t, geo))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(this.subject(c, t, merge, this.subjectTip(c, merge)))
        .child(h_flex().gap(5).items_center().min_w(0)
          .child(div().flex_none().font_family(mono).text_size(11).text_color(tint(t.ansi3, "bb"))
            .tooltip("This change's ID, shortened. Click the row to copy the full one.")
            .child(c.hash.slice(0, 7)))
          .child(this.avatar(c.author, t))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(c.author))
          .children(refs.map((ref) => this.refPill(ref, t)))
          .when(more > 0, (e) => e.child(h_flex().h(17).px(4).flex_none().items_center().rounded(5).bg(t.raised)
            .tooltip(`Also named here: ${c.refs.slice(1).join(", ")}. Each one is another name for this same change.`)
            .child(div().text_size(11).text_color(t.muted).child(`+${more}`))))
          .child(div().flex_none().font_family(mono).text_size(11).text_color(t.muted)
            .tooltip("When this change was saved, counted from today.")
            .child(relativeEpoch(c.at)))));
  }

  // What the graph means, in a row of its own: the shapes on the left, named, each one a
  // tooltip as well, plus the colours' rule.
  legend(t) {
    const mono = settings().ui_font ?? "monospace";
    const bit = (id, glyph, color, label, tip) => h_flex().id(`ghg-leg-${id}`).h(20).px(5).gap(4).flex_none()
      .items_center().rounded(5).hover((s) => s.bg(t.hover)).tooltip(tip)
      .child(div().font_family(mono).text_size(12.5).text_color(color).child(glyph))
      .child(div().text_size(11.5).text_color(t.muted).child(label));
    return h_flex().flex_none().h(28).px(8).gap(4).items_center().overflow_hidden()
      .border_b(1).border_color(t.border)
      .tooltip("Each colour is one line of work: follow a colour down the list to see where it goes.")
      .child(bit("node", "●", toneOf(t, 0), "commit", "A saved change. The dot sits on the line of work it belongs to."))
      .child(bit("merge", "◆", toneOf(t, 1), "merge", "Two lines of work joined into one."))
      .child(bit("lane", "│", toneOf(t, 2), "lane", "Another line of work passing by, untouched by this change."))
      .child(bit("fork", "┬", toneOf(t, 3), "fork", "A line of work started here: someone branched off to work separately."))
      .child(bit("join", "╯", toneOf(t, 4), "join", "A line of work ended here: its work was brought into this one."))
      .child(div().flex_1())
      .when(this.rows.length > 0, (e) => e.child(h_flex().h(18).px(6).flex_none().items_center().rounded(9)
        .bg(t.raised).border(1).border_color(t.border)
        .tooltip("How many lines of work are on screen; more lines make them thinner.")
        .child(div().text_size(11.5).text_color(t.muted)
          .child(`${Math.max(...this.rows.map((row) => row.cells.length), 1)} lanes`))));
  }

  commitsBody(t) {
    const mono = settings().ui_font ?? "monospace";
    const geo = this.geometry();
    const commits = this.rows.length;
    return v_flex().id("gh-git-commits").flex_1().min_h(0)
      .child(this.legend(t))
      .child(v_flex().id("gh-git-log").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(4).gap(1)
        .when(this.loading && !this.rows.length && !this.error, (e) => e.child(v_flex().size_full().items_center().justify_center().p(16)
          .child(div().text_color(t.muted).child("Loading…"))))
        .when(Boolean(!this.loading && this.error), (e) => e.child(v_flex().size_full().items_center().justify_center().gap(4).p(16)
          .child(div().text_color(t.muted).child(this.error))
          .when(this.folder, (x) => x.child(div().text_size(12).max_w(280).truncate().text_color(t.muted).child(this.folder)))))
        .children(this.rows.flatMap((row, index) => {
          // A day starts: its name over a hairline, so the list reads as a timeline.
          const day = this.dayLabel(row.commit.at);
          const before = index ? this.dayLabel(this.rows[index - 1].commit.at) : null;
          if (!day || day === before) return [this.graphRow(row, t, mono, geo)];
          const count = this.rows.filter((each) => this.dayLabel(each.commit.at) === day).length;
          return [this.dayRow(day, count, index, t), this.graphRow(row, t, mono, geo)];
        }))
        .when(commits > 0, (e) => e.child(h_flex().flex_none().h(24).px(4).items_center().text_size(12).text_color(t.muted)
          .child(`${commits} commits${commits >= MAX_COMMITS ? ` (first ${MAX_COMMITS})` : ""}`))));
  }

  // What a tree row means, in a row of its own, as in the graph: every mark named, each one
  // a tooltip, plus how many checkouts are waiting on something.
  treesLegend(t, count, dirty) {
    const bit = (id, glyph, color, label, tip) => h_flex().id(`ghg-tleg-${id}`).h(20).px(5).gap(5).flex_none()
      .items_center().rounded(5).hover((s) => s.bg(t.hover)).tooltip(tip)
      .child(div().text_size(12.5).text_color(color).child(glyph))
      .child(div().text_size(11.5).text_color(t.muted).child(label));
    return h_flex().flex_none().h(28).px(8).gap(4).items_center().overflow_hidden()
      .border_b(1).border_color(t.border)
      .tooltip("One colour per repo: the dot on its line heads the group, and its worktrees hang below.")
      .child(h_flex().id("ghg-tleg-repo").h(20).px(5).gap(5).flex_none().items_center().rounded(5)
        .hover((s) => s.bg(t.hover)).tooltip(`A repository under ${reposRoot().replace(home(), "~")}, with its own colour.`)
        .child(svg("mods/gh-git/repo.svg").size(13).flex_none().text_color(toneOf(t, 0)))
        .child(div().text_size(11.5).text_color(t.muted).child("repo")))
      .child(bit("tree", "▫", toneOf(t, 2), "worktree", "A checkout of that repo: the main one or a linked worktree."))
      .child(bit("files", "●", t.ansi3, "files", "Files changed but not committed in that checkout."))
      .child(bit("ahead", "↑", t.ansi2, "ahead", "Commits in the checkout that the upstream branch does not have."))
      .child(bit("behind", "↓", t.ansi1, "behind", "Commits on the upstream branch that the checkout does not have."))
      .child(bit("here", "▣", t.accent, "here", "The checkout the active space is working in."))
      .child(div().flex_1())
      .when(count > 0, (e) => e.child(h_flex().h(20).px(7).flex_none().items_center().gap(5).rounded(10)
        .bg(t.raised).border_1().border_color(t.border)
        .tooltip(`${count} checkouts in ${this.repos.length} repos${dirty ? `, ${dirty} with uncommitted files` : ", all committed"}`)
        .child(div().text_size(11.5).text_color(t.muted).child(`${count} worktrees`))
        .when(dirty > 0, (x) => x.child(div().text_size(11.5).font_medium().text_color(t.ansi3).child(`${dirty} open`)))));
  }

  treesBody(t) {
    const mono = settings().ui_font ?? "monospace";
    const current = spaces().find((s) => s.active)?.folder;
    const count = this.repos.reduce((n, r) => n + r.trees.filter((w) => !w.bare).length, 0);
    const dirty = this.repos.reduce((n, r) => n + r.trees.filter((w) => !w.bare && w.changes > 0).length, 0);
    return v_flex().id("gh-git-trees").flex_1().min_h(0)
      .child(this.treesLegend(t, count, dirty))
      .child(v_flex().id("gh-git-repos").flex_1().min_h(0).overflow_y_scrollbar().px(6).py(4).gap(5)
        .when(this.treesLoading && !this.repos.length, (e) => e.child(v_flex().size_full().items_center().justify_center().p(16)
          .child(div().text_color(t.muted).child("Loading…"))))
        .when(!this.treesLoading && !this.repos.length, (e) => e.child(v_flex().size_full().items_center().justify_center().gap(4).p(16)
          .child(div().text_color(t.muted).child(`No repos in ${reposRoot().replace(home(), "~")}`))
          .child(div().text_size(12).text_color(t.muted).child("A folder with a .git in it shows up here."))))
        .children(this.repos.flatMap((repo, index) => {
          const trees = repo.trees.filter((w) => !w.bare);
          if (!trees.length) return [];
          const color = toneOf(t, index);
          return [v_flex().id(`ghg-repo-${repo.name}`).w_full().flex_none().rounded(9).bg(t.chrome).pb(2)
            .child(this.repoHeader(repo, trees.length, color, t))
            .children(trees.map((wt) => this.treeRow(repo, wt, t, current, color, mono)))];
        }))
        .when(count > 0, (e) => e.child(h_flex().flex_none().h(24).px(4).items_center().gap(6).text_size(12).text_color(t.muted)
          .child(`${count} worktrees in ${this.repos.length} repos`))));
  }

  render(cx) {
    const t = theme();
    // Another copy (the tab bar, a key) asked for a view: follow it.
    const wanted = shared(VIEW);
    if (typeof wanted === "string" && wanted !== this.view) this.setView(wanted, cx);
    if (this.view === "issues") this.issuesView(cx);
    // Back on screen after being hidden: read now, the timer can be a quarter hour away.
    if (this.wasHidden) this.refresh(cx);
    // Another space, another repo (or another machine): re-read on the next render.
    const at = activeAt();
    if (this.view === "commits" && atKey(at) !== this.at) this.refreshCommits(cx);
    const trees = this.repos.reduce((n, r) => n + r.trees.filter((w) => !w.bare).length, 0);
    // How many the view holds: said inside that view's button, on a segment of its own, so
    // the number reads as that view's and not as a fact beside it. A narrow panel has no
    // room for a segment the pills cannot shrink, so there the count goes back to the
    // truncating text beside them. It stays on the button while another view is shown —
    // the Issues section keeps its own timer, so the number is not a leftover — and only
    // once the section has been started at all: a panel that never left Trees asks GitHub
    // nothing and has no count to give.
    const count = this.issues ? `${this.issues.items.length} open` : "";
    const fitsBadge = this.width >= 330;
    const name = this.view === "commits"
      ? (this.folder || "").split("/").filter(Boolean).pop() || ""
      : this.view === "trees"
        ? `${this.repos.length} repos · ${trees} worktrees`
        : fitsBadge ? "" : count;
    const busy = this.view === "commits" ? this.busy : this.view === "trees" ? this.treesBusy : Boolean(this.issues?.loading);
    return v_flex().id("gh-git-root").size_full().min_h(0).rounded(10).overflow_hidden().text_size(13)
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 24 || Math.abs(size.height - this.height) > 24) {
          this.width = size.width;
          this.height = size.height;
          cx.notify();
        }
      })
      .child(h_flex().h(36).flex_none().px(8).gap(6).items_center().border_b(1).border_color(t.border)
        .children(VIEWS.map((v) => {
          const on = v.id === this.view;
          // One button in two grounds: the label, and the view's own count on a segment of
          // its own, so the number reads as that view's and not as a fact beside it. Either
          // half is the same click.
          const badge = v.id === "issues" && fitsBadge ? count : "";
          return h_flex().id(`ghg-${v.id}`).h(24).flex_none().items_center().rounded(6).cursor_pointer()
            .text_size(12.5).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
            .on_click((_e, cx) => this.setView(v.id, cx))
            .child(h_flex().h_full().px(7).gap(5).items_center()
              .child(svg(v.icon).size(12).flex_none()).child(v.label))
            .when(Boolean(badge), (e) => e.child(h_flex().h_full().px(6).flex_none().items_center().rounded_r(6)
              // Its own ground, always the other way from the label's: recessed while the
              // view is the one shown, lifted while it is not.
              .bg(on ? t.chrome : t.raised).text_size(11.5).text_color(t.muted).child(badge)));
        }))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(name))
        .child(div().id("ghg-refresh").h(20).px(8).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
          .text_color(busy ? t.dim : t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx))
          .child(busy ? "…" : "Refresh")))
      .child(this.view === "commits" ? this.commitsBody(t)
        : this.view === "trees" ? this.treesBody(t)
        : (this.issues ? this.issues.body(cx)
          : v_flex().size_full().items_center().justify_center().child(div().text_color(t.muted).child("Loading…"))));
  }
}
