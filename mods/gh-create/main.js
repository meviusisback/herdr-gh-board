// The GitHub repo a checkout does not have yet: asked for here — owner, name, visibility — then
// made with `gh repo create` on the repo's machine and pushed from the repo's own checkout, so
// its main gets an upstream and the trees panel's GitHub button disappears on the next scan.
// A checkout outside the repos folder is moved into it first, under the repo's own name, because
// that is where the trees and GitHub panels read repos. A live terminal keeps the folder it
// started in — nothing can change a running program's folder — so while one works in the
// checkout the move waits and the repo is made where it is, and the dialog says why. Opened by
// spaces-tree's repo row, which shows that button only while the repo has no github.com remote.
// props: { folder, machine, name, remote, branch? } — the main checkout, the machine it is on
// (null here), the repo's name, the remote name to add, and the branch whose row asked for the
// repo: that branch is pushed too, with its own upstream, so the row that opened this dialog is
// not left saying it has no version on GitHub.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, exec, home, notify, props, closeOverlay, shared, terminals, theme } from "herdr";

// Last line of what a program said, for a toast: the real reason, not its stack of calls.
function lastLine(text) {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

// Whether a folder is the one a program works in, or sits inside it.
function inside(cwd, root) {
  const here = String(cwd ?? "").replace(/\/+$/, "");
  return here === root || here.startsWith(`${root}/`);
}

// What to call a terminal that is in the way: the program it runs, else the agent's name.
function nameOf(term) {
  return term?.program?.name || term?.agent || term?.app || "a terminal";
}

// "Oh My Pi is running in it" / "2 terminals are running in it".
function runningIn(list) {
  return list.length === 1 ? `${nameOf(list[0])} is running in it` : `${list.length} terminals are running in it`;
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

// What GitHub takes as a repository name, and as an owner: no spaces, nothing that a URL, a
// path or gh's own arguments would read differently. A leading "-" is never an argument, and
// the name is a folder under the repos root, so "." and ".." are not names.
const NAME_OK = /^(?!-)(?!\.{1,2}$)[A-Za-z0-9._-]+$/;
const OWNER_OK = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
// A branch that is pushed as an argument, never as a flag or a refspec of its own, and nothing
// git's own check-ref-format refuses (so a branch like "città" or "fix/login" still goes).
const refName = (value) => {
  const text = String(value ?? "").trim();
  const ok = text.length > 0
    && !text.startsWith("-")
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(text)
    && !text.includes("..") && !text.includes("@{") && !text.includes("//")
    && !text.endsWith("/") && !text.endsWith(".")
    && !text.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
  return ok ? text : "";
};

export default class GhCreate extends View {
  init(_props, cx) {
    this.busy = false;
    this.error = "";
    this.auth = ""; // why the login could not be read, when it could not
    this.private = true; // a repo this app makes is private until asked otherwise
    this.focused = ""; // which field has the keyboard, for its border
    this.name = InputState.new({ value: String(props()?.name ?? "") });
    this.owner = InputState.new({ value: "" });
    for (const [field, state] of [["name", this.name], ["owner", this.owner]]) {
      state.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
      state.on("submit", (_e, cx) => this.create(cx));
      state.on("focus", (_e, cx) => { this.focused = field; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focused === field) this.focused = ""; cx.notify(); });
    }
    this.name.focus();
    // The dialog is drawn after it opens: take the keyboard then, as the others do.
    cx.timer.after(600, () => this.name.focus());
    this.handle = cx.focus_handle();
    // Who the repo would belong to: the account gh is logged in as, so the field is a choice,
    // not a guess. Not being able to ask is shown where the fields are: no repo can be made.
    cx.spawn(async (cx) => {
      try {
        const r = await exec("gh", ["api", "user", "--jq", ".login"], this.at());
        if (r.code === 0 && String(r.stdout ?? "").trim()) {
          if (!this.owner.value()) this.owner.set_value(String(r.stdout).trim());
        } else {
          this.auth = lastLine(r.stderr) || "gh is not logged in";
        }
      } catch (e) {
        this.auth = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  at() {
    const machine = props()?.machine;
    return machine ? { on: machine } : {};
  }

  folder() {
    return String(props()?.folder ?? "");
  }

  // The remote the new repo is added as: "origin" unless the checkout has one already, which
  // spaces-tree says when it opens the dialog (a repo with some other remote keeps it). A host
  // (a layout entry, another mod) can say it too, so it gets the same look as every other name
  // here: a plain name, never an option.
  remote() {
    const asked = props()?.remote;
    return typeof asked === "string" && /^[A-Za-z0-9._-]+$/.test(asked) && !asked.startsWith("-") ? asked : "origin";
  }

  // The branch the new remote gets: the repo's main when it has one, the checkout's own branch
  // otherwise. "" when the checkout has no commit yet — nothing to push, and gh says so.
  async baseBranch(folder) {
    const at = this.at();
    for (const name of ["main", "master"]) {
      const r = await exec("git", ["-C", folder, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`], at).catch(() => null);
      if (r && r.code === 0) return name;
    }
    const head = await exec("git", ["-C", folder, "rev-parse", "--abbrev-ref", "HEAD"], at).catch(() => null);
    const branch = head && head.code === 0 ? String(head.stdout ?? "").trim() : "";
    return branch === "HEAD" ? "" : branch;
  }

  fullName() {
    const owner = String(this.owner.value() ?? "").trim();
    const name = String(this.name.value() ?? "").trim();
    return owner ? `${owner}/${name}` : name;
  }

  // The live terminals working in a folder now, or in a folder under it: those keep the folder
  // they started in. Read from the core's own list, which is this computer's.
  liveHere(folder) {
    const root = String(folder ?? "").replace(/\/+$/, "");
    if (!root) return [];
    return terminals().filter((term) => term?.state === "live" && inside(term.cwd, root));
  }

  // The same, for the machine the checkout is on: only that machine's core knows its terminals.
  async liveOn(folder, at) {
    if (!at.on) return this.liveHere(folder);
    const root = String(folder ?? "").replace(/\/+$/, "");
    if (!root) return [];
    const r = await exec("hc", ["ls", "--json"], at).catch(() => null);
    let list = [];
    try { list = JSON.parse(String(r?.stdout ?? "")).terminals ?? []; } catch { list = []; }
    return list.filter((term) => term?.state === "live" && inside(term.cwd, root));
  }

  // The folder the repo is made from: the repos folder Settings names, under the repo's own
  // name. A checkout living elsewhere is moved there first — the trees and GitHub panels read
  // repos there — with a link left at the old path, so a program still holding it keeps working.
  // When the folder has to stay put (a live terminal in it, other checkouts of the repo,
  // another filesystem), `kept` says why and nothing is moved.
  async intoRepos(name, at) {
    const from = this.folder();
    const dest = this.destFor(name);
    if (!from || from === dest) return { folder: from };
    // A running program keeps its folder: no process can be moved after it starts, so an agent
    // in the checkout would go on reporting the old place. The move waits for the folder to be
    // free instead of leaving the two disagreeing; the repo is made where it is now.
    const running = await this.liveOn(from, at).catch(() => []);
    if (running.length) return { folder: from, kept: `${runningIn(running)}, so it stayed where it is` };
    // A repo's other checkouts point at its .git by absolute path: moving it would break them.
    const wts = await exec("git", ["-C", from, "worktree", "list", "--porcelain"], at).catch(() => null);
    const checkouts = String(wts?.stdout ?? "").split("\n").filter((line) => line.startsWith("worktree ")).length;
    if (checkouts > 1) return { folder: from, kept: `it has ${checkouts} checkouts, so it stayed where it is` };
    // Another checkout already answers to that name: nothing is moved over it.
    const taken = await exec("test", ["-e", dest], at).catch(() => null);
    if (taken && taken.code === 0) throw new Error(`${dest.replace(home(), "~")} already exists`);
    const root = reposRoot();
    const made = await exec("mkdir", ["-p", root], at).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (made.code !== 0) throw new Error(lastLine(made.stderr) || `Could not make ${root.replace(home(), "~")}`);
    // A cross-filesystem "move" copies and deletes: the shells in the folder would be left in a
    // deleted one, so it is not attempted.
    // `df -P` answers on macOS and Linux alike (GNU `stat -c %d` does not), and a probe that
    // fails is not the same answer as "another filesystem": it says what it knows.
    const [here, there] = await Promise.all([
      exec("df", ["-P", from], at).catch(() => null),
      exec("df", ["-P", root], at).catch(() => null),
    ]);
    const deviceOf = (r) => (r && r.code === 0 ? String(r.stdout).trim().split("\n").pop()?.trim().split(/\s+/)[0] ?? "" : "");
    const [fromDev, rootDev] = [deviceOf(here), deviceOf(there)];
    if (!fromDev || !rootDev) return { folder: from, kept: `the filesystems could not be compared, so it stayed where it is` };
    if (fromDev !== rootDev) return { folder: from, kept: `it is on another filesystem, so it stayed where it is` };
    const moved = await exec("mv", ["--", from, dest], at).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
    if (moved.code !== 0) throw new Error(lastLine(moved.stderr) || `Could not move ${from.replace(home(), "~")}`);
    // The shells already in the folder keep the old path as their folder until they report the
    // new one: a link there keeps them, and the space, working in the meantime.
    await exec("ln", ["-s", dest, from], at).catch(() => null);
    return { folder: dest, from };
  }

  // Where a repo of this name belongs: the repos folder, under its own name.
  destFor(name) {
    return `${reposRoot()}/${name}`;
  }

  // One branch pushed to the new repository, tracking it: the same call for the repo's own
  // branch and for the one whose row asked for the repo.
  pushRef(folder, ref, at) {
    return exec("git", ["-C", folder, "push", "--set-upstream", this.remote(), ref], at)
      .catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
  }

  create(cx) {
    if (this.busy) return;
    const owner = String(this.owner.value() ?? "").trim();
    const name = String(this.name.value() ?? "").trim();
    if (!this.folder()) { this.error = "No folder to make the repo from"; cx.notify(); return; }
    if (!name || !NAME_OK.test(name)) { this.error = "A repository name: letters, digits, \"-\", \"_\" or \".\""; cx.notify(); return; }
    if (owner && !OWNER_OK.test(owner)) { this.error = "An owner: letters, digits or \"-\""; cx.notify(); return; }
    this.busy = true;
    this.error = "";
    const at = this.at();
    cx.spawn(async (cx) => {
      try {
        const where = await this.intoRepos(name, at);
        const folder = where.folder;
        const args = ["repo", "create", this.fullName(), "--source", folder, "--remote", this.remote(),
          this.private ? "--private" : "--public"];
        const made = await exec("gh", args, { cwd: folder, ...at });
        if (made.code !== 0) {
          this.busy = false;
          this.error = lastLine(made.stderr) || lastLine(made.stdout) || "gh repo create failed";
          cx.notify();
          return;
        }
        // The branch the repo works on lives here: pushed, so main has the upstream the Main
        // row's ↑↓ compare with and the panel stops calling the repo local. A branch whose own
        // row asked for the repo is pushed too, with its own upstream: the row that opened this
        // dialog is not left saying it has no version on GitHub.
        const base = await this.baseBranch(folder);
        const asked = refName(props()?.branch);
        const push = base ? await this.pushRef(folder, base, at) : null;
        const extra = asked && asked !== base ? await this.pushRef(folder, asked, at) : null;
        // The repo row's GitHub button goes away, and the upstream shows, on this scan.
        run("spaces-tree.scan");
        const moved = where.from ? ` — moved from ${where.from.replace(home(), "~")} to ${folder.replace(home(), "~")}` : "";
        const sent = [base, asked].filter((ref, i, all) => ref && all.indexOf(ref) === i);
        const failed = [[base, push], [asked !== base ? asked : "", extra]].find(([ref, r]) => ref && r && r.code !== 0);
        if (failed) {
          notify({ title: "GitHub repo", body: `${this.fullName()} made${moved}, but pushing ${failed[0]} failed: ${lastLine(failed[1].stderr) || lastLine(failed[1].stdout) || "git push failed"}`, level: "error" });
        } else {
          notify({ title: "GitHub repo", body: `${this.fullName()}${moved} — ${sent.join(" and ") || "no branch"} pushed${where.kept ? `, but ${where.kept}` : ""}` });
        }
        closeOverlay(props().overlay);
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const name = String(this.name.value() ?? "").trim();
    const owner = String(this.owner.value() ?? "").trim();
    const folder = this.folder().replace(home(), "~");
    const dest = name ? this.destFor(name).replace(home(), "~") : "";
    const here = this.liveHere(this.folder());
    const move = Boolean(dest) && dest !== folder
      ? here.length ? `, stays here: ${runningIn(here)}` : ` \u2192 ${dest}, moved there`
      : "";
    const machine = props()?.machine;
    const asked = refName(props()?.branch);
    const ready = Boolean(this.folder() && name && NAME_OK.test(name) && (!owner || OWNER_OK.test(owner)) && !this.auth && !this.busy);
    const label = (value) => div().flex_none().pt(14).pb(7).text_size(12.5).text_color(t.muted).child(value);
    const chips = h_flex().flex_none().gap(6)
      .child(this.choice("gh-create-private", true, t))
      .child(this.choice("gh-create-public", false, t));
    const button = (id, value, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
      .text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .text_size(13).font_medium().when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(value);
    return v_flex().id("gh-create").size_full().min_h(0).track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().flex_none().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Create GitHub repo"))
        .child(div().text_size(12).text_color(t.muted).child("Esc")))
      .child(label("Repository"))
      .child(h_flex().flex_none().gap(6).items_center()
        .child(Input.new(this.owner).flex_1().h(36).px(10).rounded(9).border_1()
          .border_color(this.focused === "owner" ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
        .child(div().text_size(13).text_color(t.muted).child("/"))
        .child(Input.new(this.name).flex_1().h(36).px(10).rounded(9).border_1()
          .border_color(this.focused === "name" ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground)))
      .child(label("Visibility"))
      .child(chips)
      // The sentence under the fields is the dialog's only prose, so it is the part that gives
      // way: it takes what is left between the fields and the buttons and scrolls when a login
      // or gh's own words add lines, instead of pushing the buttons past the frame's edge.
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().pt(9)
        .child(div().text_size(12.5).text_color(t.muted)
          .child(owner && name
            ? `github.com/${owner}/${name} from ${folder}${move}${machine ? ` on ${machine}` : ""} — its ${this.private ? "private" : "public"} repo, ${asked ? `${asked} pushed there` : "its main pushed there"}`
            : `Its own repo on GitHub, made from ${folder}${machine ? ` on ${machine}` : ""}`)))
      .when(Boolean(this.auth), (el) => el.child(div().flex_none().pt(6).text_size(12.5).text_color(t.ansi1)
        .child(`Cannot ask gh who you are: ${this.auth} — run \`gh auth login\` first`)))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().pt(6).text_size(12.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().flex_none().pt(16).gap(8).justify_end()
        .child(button("gh-create-cancel", "Cancel", false, true, () => closeOverlay(props().overlay)))
        .child(button("gh-create-go", this.busy ? "Creating…" : "Create", true, ready, (cx) => this.create(cx))));
  }

  // The visibility choice: one of the two is what the repo will be.
  choice(id, isPrivate, t) {
    const on = this.private === isPrivate;
    return h_flex().id(id).h(26).px(11).items_center().rounded(7).border_1()
      .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.raised)
      .text_color(on ? t.foreground : t.muted).text_size(11.8).font_medium().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.private = isPrivate; cx.notify(); }).child(isPrivate ? "Private" : "Public");
  }
}
