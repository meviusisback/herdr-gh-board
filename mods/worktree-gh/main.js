// Worktree dialog: { space, action: "new" | "open" | "remove" } or
// { folder, machine } for a repo without a space.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar } from "gpui-base";
import { run, props, closeOverlay, theme, spaces, panes, exec, home } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, all = panes()) {
  if (!s) return null;
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// Checkouts go to <ROOT>/<repo>/<branch, slashes as dashes>.
const ROOT = (home) => `${home}/.herdr/worktrees`;
// Home as ~ (git says C:/Users/x where Windows says C:\Users\x).
const tilde = (path, userHome) => {
  const [p, h] = [path, userHome].map((s) => s.replace(/\\/g, "/"));
  return p.startsWith(h) ? `~${p.slice(h.length)}` : path;
};
const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
// What git's check-ref-format refuses in a branch name, in the words a person reads
// while typing: "" means the name will do. Pasted prose ("no OMP agents via herdcore
// visible") is caught here instead of coming back as git's fatal: line.
function branchProblem(name) {
  if (!name) return ""; // nothing typed yet: not a problem, just a name still to come
  if (/\s/.test(name)) return "spaces aren't allowed";
  if (/[\x00-\x1f\x7f~^:?*\\[]/.test(name)) return 'it holds one of ~ ^ : ? * [ \\ or a control character';
  if (name.includes("..")) return 'it holds ".."';
  if (name.includes("@{")) return 'it holds "@{"';
  if (name.startsWith("-")) return "it can't start with -";
  for (const part of name.split("/")) {
    if (!part) return "it has an empty /part";
    if (part.startsWith(".")) return "a /part can't start with .";
    if (part.endsWith(".lock")) return 'a /part can\'t end with ".lock"';
    if (part.endsWith(".")) return "a /part can't end with .";
  }
  return "";
}
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

// Every checkout of a repo (`git worktree list`), the main one first, then
// the most recently committed: { path, branch, main, at }.
async function checkouts(repo, on) {
  const list = await git(repo.main, ["worktree", "list", "--porcelain"], on);
  if (!list.ok) return [];
  const refs = await git(repo.main, ["for-each-ref", "--format=%(refname:short)%09%(committerdate:unix)", "refs/heads"], on);
  const when = new Map(refs.out.split("\n").map((l) => l.split("\t")).map(([b, at]) => [b, Number(at) || 0]));
  const out = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    out.push({ path, branch, main: out.length === 0, at: branch ? (when.get(branch) ?? 0) : 0 });
  }
  return out.sort((a, b) => b.main - a.main || b.at - a.at);
}

// The space showing a checkout: its first terminal is in it (the deepest checkout wins).
// `places` is [{ s, cwd }], built once by the caller: a filter keystroke must not walk panes
// for every space again.
function spaceOf(path, all, on, places) {
  const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
  return places.find(({ s, cwd }) => (s.machine ?? null) === (on ?? null) && (() => {
    if (!cwd || !inside(cwd, path)) return false;
    return !all.some((c) => c.path !== path && c.path.length > path.length && inside(cwd, c.path));
  })())?.s ?? null;
}

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout === undefined ? {} : { timeout }) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.stdout ?? "").trim() };
}

// The submodule repos git keeps for a checkout (nested ones too, checked out
// or not): { name, dir, pinned }. `config` is the args that read its
// .gitmodules; `pinned` is the commit its parent records ("" if none).
async function modules(gitDir, config, on, out = [], parent = "", depth = 0) {
  const keys = await git(gitDir, ["--git-dir", gitDir, "config", ...config, "-z", "--get-regexp", "^submodule\\..*\\.path$"], on);
  if (!keys.ok) return out; // no .gitmodules, or no submodules in it
  // A chain of .gitmodules can nest: bound it, so a crafted repo cannot recurse without end.
  if (depth >= 8) return out;
  // -z: "key\nvalue" records ended by NUL, so names and paths may hold spaces.
  for (const record of keys.out.split("\0").filter(Boolean)) {
    const at = record.indexOf("\n");
    const name = record.slice("submodule.".length, at - ".path".length);
    // The name is repository text, and it becomes a path under modules/: no segment may be
    // empty or climb out of it (a hostile `.gitmodules` can name "../../escape").
    if (!name || name.split("/").some((part) => !part || part === "." || part === "..")) continue;
    const dir = `${gitDir}/modules/${name}`;
    if (!(await git(gitDir, ["--git-dir", dir, "rev-parse", "--git-dir"], on)).ok) continue; // never checked out
    const pinned = await git(gitDir, ["--git-dir", gitDir, "rev-parse", `HEAD:${record.slice(at + 1)}`], on);
    // Names are only unique within their parent: nested ones carry its name.
    out.push({ name: parent + name, dir, pinned: pinned.ok ? pinned.out : "" });
    if ((await git(gitDir, ["--git-dir", dir, "cat-file", "-e", "HEAD:.gitmodules"], on)).ok) await modules(dir, ["--blob", "HEAD:.gitmodules"], on, out, `${parent + name}/`, depth + 1);
  }
  return out;
}

// The worktree's submodules, and the names of those with commits that exist
// nowhere else: not on a remote, and not the commit the parent pins (git
// fetches that by hash, so it is often on no remote branch here).
async function submodules(top, on) {
  const gitDir = await git(top, ["rev-parse", "--absolute-git-dir"], on);
  if (!gitDir.ok) throw new Error(gitDir.err || "git rev-parse failed.");
  const mods = await modules(gitDir.out, ["--file", `${top}/.gitmodules`], on);
  const unpushed = [];
  for (const m of mods) {
    const local = await git(gitDir.out, ["--git-dir", m.dir, "rev-list", "-n1", "--all", "--not", "--remotes", ...(m.pinned ? [m.pinned] : [])], on);
    if (!local.ok) throw new Error(local.err || `Couldn't check submodule ${m.name}.`);
    if (local.out) unpushed.push(m.name);
  }
  return { mods, unpushed };
}

// The repo a folder belongs to: its main checkout and name, and whether
// the folder is itself a linked worktree. { repo: null, why } outside git,
// where why is git's own words, so the dialog never leaves a person guessing.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok) return { repo: null, why: (top.ok ? common : top).err };
  const main = common.out.endsWith("/.git") ? common.out.slice(0, -5) : common.out;
  return { repo: { top: top.out, main, name: main.split("/").pop(), linked: main !== top.out }, why: "" };
}

export default class Worktree extends View {
  init(_props, cx) {
    this.on = this.space()?.machine;
    this.userHome = this.on ? null : home();
    this.opening = props()?.action === "open";
    this.text = "";
    this.problem = ""; // what git would refuse in the branch name, as a person reads it
    this.suggestion = ""; // the same text as a branch name git takes
    this.check();
    this.list = undefined; // open: the checkouts, once read
    this.at = 0;
    this.input = InputState.new({ value: this.text, placeholder: this.opening ? "filter worktrees" : "branch name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.error = ""; this.at = 0; this.check(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(cx));
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.handle.focus(); // the root is mounted from the first frame: keep the keyboard here while loading
    if (props()?.action !== "remove") this.input.focus();
    this.busy = false;
    this.error = "";
    this.repo = undefined; // undefined: looking, null: not in git
    this.dirty = false;
    this.unpushed = [];
    this.notGit = ""; // git's own words when the folder isn't a repo
    this.empty = false; // the repo has no commits yet
    cx.spawn(async (cx) => {
      try {
        if (this.on) {
          let result;
          try { result = await exec("sh", ["-c", 'printf %s "$HOME"'], { on: this.on }); } catch {}
          if (!result || result.code !== 0 || !result.stdout.trim()) result = await exec("powershell.exe", ["-NoProfile", "-Command", "[Console]::Write($HOME)"], { on: this.on });
          if (result.code !== 0 || !result.stdout.trim()) throw new Error("Could not find the remote home folder.");
          this.userHome = result.stdout.trim().replace(/\\/g, "/");
        }
        this.folder = props()?.folder || place(this.space()) || this.userHome;
        // The repo is set last: Enter does nothing until the warnings it consents to are known.
        const found = await repoOf(this.folder, this.on);
        const repo = found.repo;
        this.notGit = found.why; // git's own words when it says no
        if (repo && !(await git(repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"], this.on)).ok) this.empty = true;
        if (repo && props().action === "remove") {
          this.dirty = (await git(repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on)).out !== "";
          this.unpushed = (await submodules(repo.top, this.on)).unpushed;
        }
        if (repo && this.opening) this.list = await checkouts(repo, this.on);
        this.repo = repo;
        cx.notify();
        // The list (and with it the filter input) only mounts once loading is
        // done, so the keyboard must move there now — a focus call made while
        // loading lands on nothing and the dialog stays keyboard-dead.
        this.handle.focus();
        if (props().action !== "remove") cx.timer.after(100, () => this.input.focus());
      } catch (error) { this.repo = null; this.error = String(error); cx.notify(); }
    });
  }

  space() {
    const p = props() ?? {};
    return spaces().find((s) => s.id === p.space) ?? (p.folder ? { folder: p.folder, machine: p.machine ?? null, name: "" } : undefined);
  }

  close() {
    closeOverlay(props().overlay);
  }

  // What the field says now, and what it would be as a name git takes.
  check() {
    const name = this.text.trim();
    this.problem = branchProblem(name);
    this.suggestion = name && this.problem ? slug(name) : "";
  }

  useSuggestion(cx) {
    this.text = this.suggestion;
    this.input.set_value(this.suggestion);
    this.check();
    this.error = "";
    this.input.focus();
    cx.notify();
  }

  go(cx) {
    // Enter in the Open filter picks a worktree; only a name makes one.
    if (this.opening || this.busy || !this.repo || this.problem) return;
    cx.spawn(async (cx) => this.work(cx));
  }

  async work(cx) {
    if (this.busy || !this.repo) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    try { this.error = props().action === "remove" ? await this.remove() : await this.create(); }
    catch (error) { this.error = String(error); }
    this.busy = false;
    if (!this.error) this.close();
    cx.notify();
  }

  async create() {
    const branch = this.text.trim();
    if (!branch) return "Type a branch name.";
    if (this.problem) return `That isn't a branch name: ${this.problem}.${this.suggestion ? ` Try ${this.suggestion}.` : ""}`;
    const dir = slug(branch);
    if (!dir) return `“${branch}” has no letters, digits, ".", "_" or "-" to name its folder.`;
    // git has the last word: the checks above cover what it refuses most often.
    if (!(await git(this.repo.top, ["check-ref-format", "--branch", branch], this.on)).ok) return `git doesn't take “${branch}” as a branch name.`;
    const path = `${ROOT(this.userHome)}/${this.repo.name}/${dir}`;
    const exists = (await git(this.repo.main, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], this.on)).ok;
    // A repo with no commits has no HEAD to branch from: git would only say
    // "fatal: invalid reference: HEAD".
    if (!exists && !(await git(this.repo.top, ["rev-parse", "--verify", "--quiet", "HEAD"], this.on)).ok) return "This repository has no commits yet: make a first commit, then a worktree.";
    const add = exists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
    const r = await git(this.repo.top, add, this.on, 600_000);
    if (!r.ok) return r.err || "git worktree add failed.";
    // Leave spaces unnamed so they follow the checkout folder and nest under the repo.
    run("space.new", { folder: path, machine: this.on ?? "" });
    return "";
  }

  shown() {
    const f = this.text.trim().toLowerCase();
    return (this.list ?? []).filter((c) => !f || `${c.branch ?? ""} ${c.path}`.toLowerCase().includes(f));
  }

  open(c) {
    if (!c) return;
    this.close();
    const places = spaces().map((s) => ({ s, cwd: place(s, panes())?.replace(/\\/g, "/") ?? null }));
    const s = spaceOf(c.path, this.list, this.on, places);
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: c.path, machine: this.on ?? "" });
  }

  async remove() {
    const s = this.space();
    const status = await git(this.repo.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
    if (!status.ok) return status.err || "git status failed.";
    // git refuses a worktree with submodules unless forced, because their
    // history goes with it. The popup already showed what's at risk; only
    // risk that appeared since it opened gets one more warning.
    const { mods, unpushed } = await submodules(this.repo.top, this.on);
    const changed = (status.out && !this.dirty) || unpushed.some((name) => !this.unpushed.includes(name));
    this.dirty ||= status.out !== "";
    this.unpushed = [...new Set([...this.unpushed, ...unpushed])];
    if (changed) return "It changed since this opened. Enter again removes it anyway.";
    // Terminals first: a shell sitting in the folder keeps it busy on Windows.
    run("space.close", { id: s.id, confirmed: true });
    const force = this.dirty || mods.length > 0;
    const r = await git(this.repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), this.repo.top], this.on, 600_000);
    return r.ok ? "" : r.err || "git worktree remove failed.";
  }

  key(e, cx) {
    if (e.key === "escape") return this.close();
    if (this.opening) {
      const n = this.shown().length;
      if (e.key === "enter") this.open(this.shown()[this.at]);
      else if ((e.key === "down" || e.key === "up") && n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
      else return;
      cx.stop_propagation();
      return cx.notify();
    }
    if (e.key === "enter" && props()?.action === "remove") return this.go(cx);
  }

  renderOpen(t) {
    const r = this.repo;
    const rows = this.shown();
    const all = this.list ?? [];
    const paneList = panes();
    // Every space's live folder, read once: a row's "open" mark is a lookup, not a pane walk.
    const places = spaces().map((s) => ({ s, cwd: place(s, paneList)?.replace(/\\/g, "/") ?? null }));
    const row = (c, i) => {
      const on = i === this.at;
      const there = spaceOf(c.path, all, this.on, places);
      return v_flex()
        .id(`wt-${i}`)
        .flex_none()
        .h(44)
        .px(10)
        .justify_center()
        .rounded(7)
        .cursor_pointer()
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click(() => this.open(c))
        .child(
          h_flex()
            .gap(8)
            .items_center()
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.branch ?? "detached"))
            .when(c.main, (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child("main checkout")))
            .when(Boolean(there), (el) => el.child(div().flex_none().text_size(12).text_color(t.accent).child("open")))
            .when(!there && c.at > 0, (el) => el.child(div().flex_none().text_size(12).text_color(t.muted).child(ago(c.at)))),
        )
        .child(div().truncate().text_size(12.5).text_color(t.muted).child(tilde(c.path, this.userHome ?? "")));
    };
    const count = rows.length === all.length ? `${all.length} checkouts` : `${rows.length}/${all.length} checkouts`;
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(h_flex().child(div().flex_1().font_semibold().text_color(t.foreground).child(`Open worktree${r ? ` of ${r.name}` : ""}`)).child(div().text_size(12).text_color(t.muted).child(r ? count : "")))
      .when(r === undefined || (r && this.list === undefined), (el) => el.child(div().text_color(t.muted).child("\u2026")))
      .when(r === null, (el) => el.child(div().text_color(t.muted).child(`${this.folder ? tilde(this.folder, this.userHome ?? "") : "This folder"} is not in a git repository.${this.notGit ? ` git says: ${this.notGit.split("\n")[0]}` : ""}`)))
      .when(Boolean(r && this.list), (el) =>
        el
          .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
          .child(
            div()
              .relative()
              .flex_1()
              .min_h(0)
              .child(
                v_flex()
                  .id("wt-list")
                  .size_full()
                  .overflow_y_scroll()
                  .children(rows.map(row))
                  .when(rows.length === 0, (el) => el.child(div().p(10).text_color(t.muted).child("No matching worktrees."))),
              )
              .child(Scrollbar.vertical("wt-list").absolute().inset_0()),
          ),
      )
      .child(h_flex().justify_end().text_size(12).text_color(t.muted).child("\u2191\u2193 choose \u00b7 \u21b5 open \u00b7 esc close"));
  }

  render(cx) {
    const t = theme();
    if (this.opening) return this.renderOpen(t);
    const remove = props()?.action === "remove";
    const s = this.space();
    const r = this.repo;
    const title = remove ? `Remove worktree ${s?.name ?? ""}?` : `New worktree${r ? ` of ${r.name}` : ""}`;
    const detail =
      r === undefined
        ? "…"
        : r === null
          ? `${this.folder ? tilde(this.folder, this.userHome) : "This folder"} is not in a git repository.${this.notGit ? ` git says: ${this.notGit.split("\n")[0]}` : ""}`
          : remove
            ? !r.linked
              ? "This is the repository's main checkout, not a worktree."
              : `Closes the space and deletes ${tilde(r.top, this.userHome)}. The branch stays.`
            : this.empty
              ? "This repository has no commits yet: make a first commit, and a worktree can branch from it."
              : `A new space on a checkout in ${tilde(ROOT(this.userHome), this.userHome)}/${r.name}/. A branch that exists is checked out; a new one starts from here.`;
    const blocked = !r || (remove && !r.linked);
    return v_flex()
      .id("worktree")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.key(e, cx))
      .size_full()
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .when(remove && this.dirty, (el) => el.child(div().text_color(t.blocked).child("It has uncommitted changes: they will be lost.")))
      .when(remove && this.unpushed.length > 0, (el) => el.child(div().text_color(t.blocked).child(`Submodule ${this.unpushed.join(", ")} has commits that aren't pushed anywhere: they will be lost.`)))
      .when(!remove && !blocked, (el) =>
        el.child(
          Input.new(this.input)
            .h(32)
            .px(10)
            .items_center()
            .rounded(6)
            .border(1)
            .border_color(this.inputFocused ? t.accent : t.input)
            .bg(t.background)
            .text_color(t.foreground),
        ),
      )
      .when(Boolean(this.error) && !this.problem, (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when(!remove && !blocked && Boolean(this.problem), (el) =>
        el
          .child(div().text_color(t.blocked).child(`That isn't a branch name: ${this.problem}.`))
          .when(Boolean(this.suggestion), (el2) =>
            el2.child(
              h_flex()
                .id("wt-suggest")
                .gap(4)
                .text_color(t.accent)
                .cursor_pointer()
                .hover((s) => s.text_color(t.foreground))
                .on_click((_e, cx) => this.useSuggestion(cx))
                .child("Use")
                .child(div().font_semibold().child(this.suggestion)),
            ),
          ),
      )
      .child(div().flex_1())
      .child(
        h_flex()
          .justify_end()
          .text_size(12)
          .text_color(t.dim)
          .gap(6)
          .when(this.busy, (el) => el.child(div().frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
          .child(this.busy ? "working…" : blocked || this.problem ? "esc close" : remove ? "↵ remove · esc cancel" : "↵ create · esc cancel"),
      );
  }
}
