// Herdr's own Settings window is Herdr's (frame/, rewritten every start), so the settings
// that have no field there live here. One section, the folder repos live in: where the Trees
// and Issues panels look for checkouts (gh-git, gh-repos), and where spaces-tree reads a
// checkout's repo name from. A new space makes its folder here only when its dialog is asked
// for a repo (space-new's other choice keeps it under ~/spaces). Kept in shared("repos.root");
// opened with `mod.open settings`
// (Ctrl+Shift+Alt+S), the tab + menu, or the terminal menu.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, notify, props, closeOverlay, setShared, shared, theme, pickFolder } from "herdr";

const DEFAULT_ROOT = () => `${home()}/repo`;

// The folder repos live in, as every mod reads it: ~ is the home folder, a trailing slash
// is nothing. Written back expanded, so the panels and the spaces tree see a plain path.
function root() {
  const chosen = shared("repos.root");
  const path = typeof chosen === "string" && chosen.trim() ? chosen.trim() : DEFAULT_ROOT();
  return path.replace(/^~(?=$|\/)/, home()).replace(/\/+$/, "");
}

export default class Settings extends View {
  init(_props, cx) {
    this.error = "";
    this.busy = false;
    this.focused = true;
    this.input = InputState.new({ value: root().replace(home(), "~") });
    this.input.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.save(cx));
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.input.focus();
    // The dialog is drawn after it opens: take the keyboard then, as the prompt does.
    cx.timer.after(600, () => this.input.focus());
    this.handle = cx.focus_handle();
  }

  // An empty field means the default folder, not "no repos folder".
  typed() {
    return String(this.input.value() ?? "").trim() || DEFAULT_ROOT();
  }

  save(cx) {
    if (this.busy) return;
    const path = this.typed().replace(/^~(?=$|\/)/, home()).replace(/\/+$/, "");
    if (!path.startsWith("/")) {
      this.error = "An absolute path, or one starting with ~";
      cx.notify();
      return;
    }
    // A folder is a folder: "/" or a path that climbs with ".." is not a place for repos.
    if (path === "/" || path.split("/").some((part) => part === "." || part === "..")) {
      this.error = "A plain absolute path: no \"/\", no \".\" or \"..\"";
      cx.notify();
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const made = await exec("mkdir", ["-p", path]);
        if (made.code !== 0) {
          this.busy = false;
          this.error = String(made.stderr ?? "").trim() || `Could not make ${path}`;
          cx.notify();
          return;
        }
        // The real path (symlinks followed) is what every reader gets, so nothing downstream
        // has to know about a link in the way.
        const real = await exec("realpath", [path]).catch(() => null);
        const canonical = (real?.code === 0 && real.stdout.trim().startsWith("/") ? real.stdout.trim() : path).replace(/\/+$/, "");
        const isDir = await exec("test", ["-d", canonical]).catch(() => null);
        if (isDir?.code !== 0) {
          this.busy = false;
          this.error = `${canonical} is not a folder`;
          cx.notify();
          return;
        }
        setShared("repos.root", canonical);
        // The panels read the new folder now instead of on their next 15-second pass.
        setShared("gh-board.rescan", Date.now());
        notify({ title: "Repos folder", body: canonical.replace(home(), "~") });
        closeOverlay(props().overlay);
      } catch (e) {
        this.busy = false;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  choose(cx) {
    cx.spawn(async (cx) => {
      try {
        const folder = await pickFolder({ prompt: "The folder repos live in" });
        if (!folder) return;
        this.input.set_value(folder.replace(home(), "~"));
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    const button = (id, value, primary, enabled, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary && enabled ? t.solid : t.raised)
      .text_color(!enabled ? t.dim : primary ? t.solid_foreground : t.foreground)
      .text_size(13).font_medium().cursor_pointer().when(enabled, (el) => el.hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (enabled) action(cx); }).child(value);
    return v_flex().id("settings").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Settings"))
        .child(div().text_size(12).text_color(t.muted).child("Esc")))
      .child(div().pt(16).pb(7).text_size(12.5).text_color(t.muted).child("Repos folder"))
      .child(h_flex().gap(8).items_center()
        .child(Input.new(this.input).flex_1().h(36).px(10).rounded(9).border_1()
          .border_color(this.focused ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
        .child(button("settings-choose", "Choose…", false, true, (cx) => this.choose(cx))))
      .child(div().pt(7).text_size(12.5).text_color(t.muted)
        .child("New spaces' repo folders are made here, and the Trees and Issues panels read repos here. Default: ~/repo"))
      .when(Boolean(this.error), (el) => el.child(div().pt(6).text_size(12.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().pt(20).gap(8).justify_end()
        .child(button("settings-cancel", "Cancel", false, true, () => closeOverlay(props().overlay)))
        .child(button("settings-save", this.busy ? "Saving…" : "Save", true, !this.busy, (cx) => this.save(cx)))
      );
  }
}
