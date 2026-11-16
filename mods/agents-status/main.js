import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, spaces, theme, shared, run } from "herdr";

// The bottom-right corner: how far the shown space is from origin (commits ahead/behind, what is
// not committed), then every agent's state and its count, as colored chips — so the window says
// at a glance what runs, what waits for you, and what still has to be pushed.
const ORDER = ["blocked", "working", "done", "idle"];

function alpha(color, a) {
  const c = String(color ?? "");
  return /^#[0-9a-f]{6}$/i.test(c) ? c + a : c;
}

export default class AgentsStatus extends View {
  init(_props, _cx) {
    // Nothing to poll: the scan that feeds the git chips writes shared state, and a write
    // re-renders every mod — `git()` reads it here, when it is drawn.
  }

  statusChip(status, list, t) {
    const count = list.length;
    const color = status === "idle" ? t.muted : (t[status] ?? t.dim);
    const live = status === "working" || status === "blocked";
    // Working and blocked agents open the active wall; done and idle open every agent's
    // wall, so the two states a person sees are both one click from the wall.
    const wall = live ? "agent-wall.active" : "agent-wall.all";
    return h_flex().id(`st-${status}`).h(22).px(8).gap(6).items_center().rounded(11).flex_none().cursor_pointer()
      .bg(alpha(color, "24")).border(1).border_color(alpha(color, "59"))
      .tooltip(`${count} ${status}: ${list.map((a) => a.program?.name || a.tab_name || "terminal").join(", ")} — click to open the wall`)
      .on_click(() => run(wall))
      .child(div().size(7).flex_none().rounded(4).bg(color).when(live, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 })))
      .child(div().text_size(12.5).font_semibold().text_color(color).child(`${count} ${status}`));
  }

  // A git chip: the same shape as a status chip (same height, radius, tint and weight), with a
  // glyph where the status chips have their dot. One line, one look.
  bit(glyph, text, color, tip) {
    return h_flex().h(22).px(8).gap(6).items_center().rounded(11).flex_none().bg(alpha(color, "24"))
      .border(1).border_color(alpha(color, "59")).when(Boolean(tip), (el) => el.tooltip(tip))
      .when(Boolean(glyph), (el) => el.child(div().flex_none().text_size(12.5).text_color(color).child(glyph)))
      .child(div().text_size(12.5).font_semibold().text_color(color).child(text));
  }

  // The shown space's distance from origin, from what the spaces panel scanned.
  git(t) {
    const space = spaces().find((s) => s.active);
    const info = (shared("spaces-tree.git") ?? {})[space?.id] ?? null;
    if (!info) return [];
    const bits = [];
    if (!info.upstream) bits.push(this.bit("", "no upstream", t.muted, "this branch is on no remote: nothing of it is pushed"));
    else {
      // Only what differs from origin: nothing to say when it is in step.
      if (info.ahead > 0) bits.push(this.bit("↑", `${info.ahead} to push`, t.ansi2, `${info.ahead} commits on this branch are not on origin`));
      if (info.behind > 0) bits.push(this.bit("↓", `${info.behind} to pull`, t.ansi1, `${info.behind} commits on origin are not here yet`));
    }
    if (info.dirty > 0) bits.push(this.bit("✎", `${info.dirty} uncommitted`, t.ansi3, "changed or untracked paths, not committed"));
    if (info.mainAhead > 0) bits.push(this.bit("↑", `main+${info.mainAhead}`, t.ansi4, `${info.mainAhead} commits here are not in ${info.mainRef}`));
    return bits;
  }

  render() {
    const t = theme();
    const list = agents();
    const by = (status) => list.filter((a) => (a.status ?? "idle") === status);
    const counts = {};
    for (const agent of list) counts[agent.status ?? "idle"] = (counts[agent.status ?? "idle"] ?? 0) + 1;
    return h_flex().id("agents-status").size_full().justify_end().px(16).gap(10).items_center()
      .bg(t.chrome).border_t(1).border_color(t.border)
      .when(list.length === 0, (el) => el.child(div().text_size(12.5).text_color(t.muted).child("no agents")))
      .children(this.git(t))
      .child(div().w(1).h(16).flex_none().bg(t.border))
      .children(ORDER.filter((status) => counts[status]).map((status) => this.statusChip(status, by(status), t)))
      .child(h_flex().h(22).px(8).items_center().rounded(11).flex_none().cursor_pointer().bg(alpha(t.muted, "14"))
        .tooltip("every agent this window shows — click to open the wall")
        .hover((s) => s.bg(alpha(t.foreground, "18")))
        .on_click(() => run("agent-wall.all"))
        .child(div().text_size(12.5).font_semibold().text_color(t.muted).child(`${list.length} total`)));
  }
}
