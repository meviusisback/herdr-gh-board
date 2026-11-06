import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home, theme, openOverlay, run, spaces } from "herdr";
import * as fs from "fs/promises";

// Open worktrees of the repos under ~/repo, grouped by repo: one row per
// checkout (main + linked trees). A row jumps to the space already showing
// that folder, or opens it. Crafted to sit next to gh-board's Issues panel.
const REFRESH_MS = 15000;

const text = (value) => String(value ?? "").replace(/[⁡-⁣⁢-⁢⁤-⁬⁦-⁩]/g, "");

async function scanRepos(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries.filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const dir = `${root}/${e}`;
    try {
      if (!(await fs.exists(`${dir}/.git`))) continue;
      const r = await exec("git", ["-C", dir, "worktree", "list", "--porcelain"]);
      if (r.code !== 0) continue;
      const trees = [];
      let cur = null;
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("worktree ")) { cur = { path: line.slice(9), branch: "", bare: false }; trees.push(cur); }
        else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
        else if (cur && line.startsWith("bare")) cur.bare = true;
        else if (cur && line.startsWith("detached")) cur.branch = "(detached)";
      }
      if (trees.length) out.push({ dir, name: e, trees });
    } catch { /* not a checkout */ }
  }
  return out;
}

export default class GhTrees extends View {
  init(_props, cx) {
    this.repos = [];
    this.loading = true;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  refresh(cx) {
    if (this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        this.repos = await scanRepos(`${home()}/repo`);
      } finally {
        this.busy = false;
        this.loading = false;
        cx.notify();
      }
    });
  }

  // The space showing this folder (a worktree space), else the main checkout's
  // own space if the folder is a main checkout shown somewhere.
  openTree(path, name) {
    const space = spaces().find((s) => s.folder === path);
    if (space) { run("space.select", { id: space.id }); return; }
    run("space.new", { name, folder: path });
  }

  treeRow(repo, wt, t, current) {
    const main = wt.path === repo.dir;
    const label = main ? "main" : text(wt.path.split("/").filter(Boolean).pop());
    const on = current === wt.path;
    return h_flex().id(`ght-${wt.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click(() => this.openTree(wt.path, main ? repo.name : label))
      .child(svg("mods/gh-trees/branch.svg").size(12).flex_none().text_color(on ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(label))
      .when(Boolean(wt.branch) && wt.branch !== label, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(text(wt.branch))))
      .when(main, (e) => e.child(div().flex_none().text_size(9.5).text_color(t.dim).child("checkout")));
  }

  render(cx) {
    const t = theme();
    const current = spaces().find((s) => s.active)?.folder;
    const count = this.repos.reduce((n, r) => n + r.trees.filter((w) => !w.bare).length, 0);
    return v_flex().id("gh-trees-root").size_full().min_h(0).rounded(10).overflow_hidden().text_size(12.5)
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Worktrees"))
        .child(div().flex_1())
        .child(div().id("ght-refresh").h(20).px(8).flex().items_center().rounded(6).text_size(11)
          .text_color(this.busy ? t.dim : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => this.refresh(cx))
          .child(this.busy ? "…" : "Refresh")))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(this.loading && !this.repos.length, (e) => e.child(v_flex().size_full().items_center().justify_center().p(16)
          .child(div().text_color(t.muted).child("Loading…"))))
        .when(!this.loading && !this.repos.length, (e) => e.child(v_flex().size_full().items_center().justify_center().p(16)
          .child(div().text_color(t.muted).child("No repos in ~/repo"))))
        .children(this.repos.flatMap((repo) => {
          const trees = repo.trees.filter((w) => !w.bare);
          if (!trees.length) return [];
          return [
            div().px(8).pt(6).pb(2).text_size(11).font_medium().text_color(t.dim).child(text(repo.name)),
            ...trees.map((wt) => this.treeRow(repo, wt, t, current)),
          ];
        })))
      .when(count > 0, (e) => e.child(h_flex().flex_none().h(24).px(10).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(`${count} worktrees in ${this.repos.length} repos`)));
  }
}
