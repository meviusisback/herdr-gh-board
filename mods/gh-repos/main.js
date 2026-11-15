import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, shared, setShared, closeOverlay, pickFolder, home } from "herdr";

// Which repos the issues/PRs panel asks about, and where they come from:
// shared("repos.root") is the folder scanned (set in Settings, mods/settings),
// shared("gh-board.selected") the picked repos (null: all), shared("gh-board.rescan")
// asks for a new scan.
function scanned() {
  const list = shared("gh-board.repos");
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (typeof entry === "string" ? { repo: entry, dir: null } : entry))
    .filter((entry) => entry && entry.repo);
}

export default class GhRepos extends View {
  init() {
    this.error = "";
  }

  root() {
    const chosen = shared("repos.root");
    const path = (typeof chosen === "string" && chosen.trim() ? chosen.trim() : `${home()}/repo`)
      .replace(/^~(?=$|\/)/, home())
      .replace(/\/+$/, "");
    // Only a plain absolute path: a value planted in shared state must not climb anywhere.
    if (path === "/" || !path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")) return `${home()}/repo`;
    return path;
  }

  selected() {
    const pick = shared("gh-board.selected");
    return Array.isArray(pick) ? pick : null;
  }

  toggle(repo) {
    const all = scanned().map((entry) => entry.repo);
    const pick = this.selected() ?? [...all];
    const next = pick.includes(repo) ? pick.filter((name) => name !== repo) : [...pick, repo];
    // Picking every repo is the same as picking none: keep the plain case small.
    setShared("gh-board.selected", next.length === all.length ? null : next);
  }

  rescan() {
    setShared("gh-board.rescan", Date.now());
  }

  async changeFolder(cx) {
    try {
      const folder = await pickFolder({ prompt: "Scan this folder" });
      if (!folder) return;
      setShared("repos.root", folder);
      setShared("gh-board.rescan", Date.now());
      this.error = "";
    } catch (e) {
      this.error = String(e?.message || e);
    }
    cx.notify();
  }

  row(entry, t, pick) {
    const on = pick === null || pick.includes(entry.repo);
    return h_flex().id(`repo-${entry.repo}`).h(26).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.toggle(entry.repo))
      .child(div().w(14).h(14).flex_none().flex().items_center().justify_center().rounded(4)
        .border_1().border_color(on ? t.accent : t.border)
        .bg(on ? t.accent : t.chrome)
        .when(on, (e) => e.child(svg("mods/gh-repos/check.svg").size(10).text_color(t.accent_foreground))))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(entry.repo))
      .when(!entry.dir, (e) => e.child(div().text_size(10.5).text_color(t.muted).child("?")));
  }

  button(id, label, t, onClick, primary) {
    return div().id(id).h(24).px(10).flex().items_center().rounded(6).text_size(12.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.muted)
      .hover((s) => s.bg(primary ? t.solid : t.hover))
      .on_click(onClick).child(label);
  }

  render(cx) {
    const t = theme();
    const framed = !props()?.overlay;
    const all = scanned();
    // One read of the picks, for the count and every row.
    const pick = this.selected();
    const on = all.filter((entry) => pick === null || pick.includes(entry.repo));

    return v_flex().w_full().p(12).gap(8).text_color(t.foreground)
      .when(framed, (e) => e.rounded(12).bg(t.popover).border_1().border_color(t.border).shadow_lg())
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("Repos"))
        .child(div().flex_1())
        .child(div().text_size(11.5).text_color(t.muted).child(`${on.length} of ${all.length}`)))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(this.root()))
        .child(this.button("repos-rescan", "Rescan", t, () => this.rescan()))
        .child(this.button("repos-folder", "Folder…", t, () => this.changeFolder(cx))))
      .child(div().flex_none().h(Math.min(320, Math.max(44, all.length * 27 + 8))).overflow_y_scrollbar().gap(1)
        .when(!all.length, (e) => e.child(div().p(8).text_size(12).text_color(t.muted).child("Nothing scanned here yet — Rescan, or pick another folder.")))
        .children(all.map((entry) => this.row(entry, t, pick))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(6).items_center().pt(2).border_t(1).border_color(t.border)
        .child(this.button("repos-all", "All", t, () => setShared("gh-board.selected", null)))
        .child(this.button("repos-none", "None", t, () => setShared("gh-board.selected", [])))
        .child(div().flex_1())
        .child(this.button("repos-done", "Done", t, () => closeOverlay(props().overlay), true)));
  }
}
