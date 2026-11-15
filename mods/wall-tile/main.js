// One tile's bar, above its terminal in the wall (`mods/agent-wall`): which space
// and agent it is, its state, and the branch it sits on. Click to focus it.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, panes, props, run, setShared, theme } from "herdr";

// A space, an agent and a branch can name themselves, and a name can carry bidi overrides:
// they never reach the tile, so a title cannot reorder what sits beside it.
const plain = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

export default class WallTile extends View {
  render() {
    const t = theme();
    const terminal = props()?.terminal;
    const agent = agents().find((a) => a.address === terminal);
    if (!agent) return div();
    const pane = panes().find((p) => p.terminal === terminal);
    const status = agent.status ?? "idle";
    const color = status === "idle" ? t.muted : (t[status] ?? t.dim);
    return h_flex().id(`wall-head-${terminal}`).size_full().gap(6).px(7).items_center().rounded(4)
      .bg(t.chrome).border(1).border_color(t.border)
      .hover((s) => s.bg(t.hover).border_color(t.input))
      .on_click(() => run("pane.focus", { terminal }))
      .child(div().size(7).flex_none().rounded(4).bg(color))
      .child(div().flex_none().max_w(140).truncate().text_size(12.5).font_medium().text_color(t.foreground).child(plain(agent.space_name)))
      .child(div().flex_1().truncate().text_size(12).text_color(t.muted).child(plain(agent.program?.name ?? agent.app ?? "")))
      .when(Boolean(pane?.branch), (el) => el.child(div().flex_none().truncate().max_w(120).text_size(12).text_color(t.muted).child(plain(pane.branch))))
      // A tile is a block, not a pane: closing it is taking the agent out of the wall.
      .child(div().id(`wall-close-${terminal}`).h(18).px(5).flex_none().flex().items_center().justify_center().rounded(5)
        .text_size(12.5).text_color(t.muted).border(1).border_color(t.border)
        .hover((s) => s.bg(t.hover).text_color(t.foreground).border_color(t.input))
        .tooltip("Take this agent out of the wall")
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setShared("agent-wall.drop", terminal); run("agent-wall.remove"); })
        .child("\u2715"));
  }
}
