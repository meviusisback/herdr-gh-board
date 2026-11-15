// The name of a new space, asked before anything exists. A space gets a folder of its own: by
// default ~/spaces/<name>, made on the space's machine and handed to `space.new` as its folder,
// so a space never starts in whichever folder the pane it was opened from happened to be in —
// one of the repos included. Asked for instead, "New repo folder on main" makes the folder under
// the repos folder Settings names (~/repo unless changed, where the checkouts live, so the spaces
// tree groups it like one) and initializes it as a repository on main, ready for the worktrees
// made from its main later; a folder that already is a repository is left exactly as it is.
// Either way the space opens its own shell: no agent is started for it, the person picks one
// from the + menu.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, exec, home, notify, props, closeOverlay, shared, spaces, theme } from "herdr";

// Where a space's own folder lives when no repo is asked for: outside the repos folder
// (Settings' `repos.root`), so the spaces tree and the GitHub panels never read it as a
// checkout, and visible, because it is where the space's terminals start.
const SPACES_ROOT = () => `${home()}/spaces`;

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

// A name that is also a folder name: lowercase, no spaces, nothing a path or the tree would read
// as a separator. A name with no letters or digits left (another script) still gets a folder:
// the space keeps the name it was given.
function folderName(name) {
  const made = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/^[.\-]+|[.\-]+$/g, "");
  return made || "space";
}

// Last line of what a program said, for a toast: the real reason, not its stack of calls.
function lastLine(text) {
  return String(text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
}

// A new space with a repo starts as a repository on main: the checkout the spaces tree shows
// as its Main row, and the one every worktree made later starts from. A folder that already
// is a repository is left exactly as it is. It runs on the space's machine, where the folder is.
async function ensureRepo(folder, machine) {
  const at = machine ? { on: machine } : {};
  // The prefix is empty exactly when the folder is a repository's own top: a folder inside
  // some larger repository is not a repository of its own, whatever its path looks like.
  const found = await exec("git", ["-C", folder, "rev-parse", "--show-prefix"], at);
  if (found.code === 0) {
    if (!String(found.stdout ?? "").trim()) return;
    throw new Error(`${folder} is inside another repository`);
  }
  // Only "there is no repository here" means initialise one: any other failure (a checkout
  // owned by another user, say) must be shown, not papered over.
  if (!/not a git repository|not a repository/i.test(String(found.stderr ?? ""))) {
    throw new Error(lastLine(found.stderr) || "git rev-parse failed");
  }
  const init = await exec("git", ["init", "-b", "main", "--", folder], at);
  if (init.code !== 0) throw new Error(lastLine(init.stderr) || "git init failed");
  // Without a commit there is no main branch yet, so no worktree could be started from it.
  const commit = await exec("git", ["-C", folder, "commit", "--allow-empty", "-m", "Start"], at);
  if (commit.code !== 0) throw new Error(lastLine(commit.stderr) || "git commit failed");
}

export default class SpaceNew extends View {
  init(_props, cx) {
    this.text = "";
    this.busy = false;
    this.focused = true;
    this.repo = false; // its own folder, or a repo's checkout: a space is a space first
    this.input = InputState.new({ value: "" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.create(cx));
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.input.focus();
    // The dialog is drawn after it opens: take the keyboard then, as the prompt does.
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
    this.homes = {}; // machine -> its home, read when the dialog is opened for one
    if (this.machine()) cx.spawn(async (cx) => { await this.readHome(this.machine(), cx); });
  }

  // The folder this space is made on, and the one the hint reads out: its own under ~/spaces,
  // or a checkout under the repos folder when a repo is asked for — under that machine's home
  // when the space is on another one, so `~/spaces` there is where that machine keeps it.
  folder(name) {
    return this.atHome(`${this.repo ? reposRoot() : SPACES_ROOT()}/${folderName(name)}`, this.machine());
  }

  // A home on another machine is that machine's, not this one's: a different user, a
  // different `/Users` or `/home`. Read once, by the dialog, before it makes a folder.
  homeFor(machine) {
    return machine ? (this.homes?.[machine] ?? null) : home();
  }

  async readHome(machine, cx) {
    if (!machine || this.homes?.[machine]) return;
    const r = await exec("sh", ["-lc", 'printf %s "$HOME"'], { on: machine }).catch(() => null);
    const found = String(r?.stdout ?? "").trim().replace(/\/+$/, "");
    if (found.startsWith("/")) {
      this.homes[machine] = found;
      cx.notify();
    }
  }

  // The same layout of folders on the space's own machine: a path under this home keeps its
  // place under that one.
  atHome(path, machine) {
    const there = this.homeFor(machine);
    return there && there !== home() ? path.replace(home(), there) : path;
  }

  // The machine the space is made on: the one asked for (the picker's per-machine rows), else
  // the shown space's, so a space opened while another machine's space is shown lives there —
  // and its folder is made there, never here by mistake.
  machine() {
    const asked = props()?.machine;
    if (typeof asked === "string") return asked;
    return spaces().find((s) => s.active)?.machine ?? "";
  }

  create(cx) {
    const name = this.name();
    if (!name || this.busy) return;
    this.busy = true;
    const machine = this.machine();
    cx.spawn(async (cx) => {
      try {
        // On another machine its own home answers first: the folder is made there, not here.
        await this.readHome(machine, cx);
        const folder = this.folder(name);
        const made = await exec("mkdir", ["-p", folder], machine ? { on: machine } : {});
        if (made.code !== 0) {
          this.busy = false;
          notify({ title: "New space", body: lastLine(made.stderr) || `Could not make ${folder}`, level: "error" });
          cx.notify();
          return;
        }
        // A failure here throws to the catch below: no space is made on a folder that is not
        // a working repository.
        if (this.repo) await ensureRepo(folder, machine);
        // The folder is passed: a space made without one starts where the focused terminal is.
        run("space.new", { name, folder, machine });
        closeOverlay(props().overlay);
      } catch (e) {
        this.busy = false;
        notify({ title: "New space", body: String(e?.message ?? e), level: "error" });
        cx.notify();
      }
    });
  }

  // The name in the field itself, not only the copy a change event left behind.
  name() {
    return (this.input.value() || this.text).trim();
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const name = this.name();
    const folder = this.folder(name).replace(this.homeFor(this.machine()) ?? home(), "~");
    const machine = this.machine();
    const label = (value) => div().pt(16).pb(7).text_size(12.5).text_color(t.muted).child(value);
    const choice = (id, value, text) => h_flex().id(id).h(26).px(11).items_center().rounded(7).border_1()
      .border_color(this.repo === value ? t.accent : t.border).bg(this.repo === value ? t.selected : t.raised)
      .text_color(this.repo === value ? t.foreground : t.muted).text_size(11.8).font_medium().cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.repo = value; cx.notify(); }).child(text);
    const button = (id, value, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
      .text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .text_size(13).font_medium().when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(value);
    return v_flex().id("space-new").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("New space"))
        .child(div().text_size(12).text_color(t.muted).child("Esc")))
      .child(label("Name"))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1()
        .border_color(this.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(label("Repo"))
      .child(h_flex().gap(6)
        .child(choice("space-new-own", false, "Own folder"))
        .child(choice("space-new-repo", true, "New repo folder on main")))
      .child(div().pt(7).text_size(12.5).text_color(t.muted)
        .child(!this.repo ? `Its own folder, made under ${SPACES_ROOT().replace(home(), "~")} and named after it`
          : name ? `Folder: ${folder}${machine ? ` on ${machine}` : ""} — repository on main, created if missing`
          : `Its folder is made under ${reposRoot().replace(home(), "~")}, named after it`))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("space-new-cancel", "Cancel", false, true, () => closeOverlay(props().overlay)))
        .child(button("space-new-create", this.busy ? "Creating…" : "Create", true, Boolean(name) && !this.busy, (cx) => this.create(cx)))
      );
  }
}
