// "Wall": a layout of its own (layouts/agent-wall.json) that shows the live terminals
// of the agents already running, across spaces, side by side. Nothing is moved: each
// agent stays in its space, and the layout you came from is never edited — switching
// back is all it takes. The chip at the tab strip's right end (drawn by `tabs-gh`, which
// sends this mod the same command the key does) says which agents the wall holds and
// flips between the two views; the layout's `wall-chip` block is a 0 px mount that keeps
// a copy of this mod alive for that command. The set it shows is remembered. The wall is a
// view of the world, not a place to work: picking a tab, an agent or a space leaves it for
// that pick, whether the pick comes from a mod's click or straight from a key. The file is
// rewritten whenever agents come and go (their addresses die with a restart).

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, appHome, focused, layout, notify, readTextFile, run, shared, setShared, nextCommand, spaces, theme, writeTextFile } from "herdr";
import { activeAddresses, leftWall, place, rebuild, wallSet } from "./set.js";

const ON = "agent-wall.on"; // is the wall showing
const BACK = "agent-wall.back"; // the layout to return to
const BASE = "agent-wall.base"; // its tree, to build the wall from (the shown one is the wall)
const SIG = "agent-wall.sig"; // the agents the wall was built for
const LIST = "agent-wall.list"; // the agents a gesture picked, in order (none: every agent)
const MODE = "agent-wall.mode"; // "active": the wall is the frozen working/blocked set
const FEAT = "agent-wall.active"; // the addresses that click froze
const PENDING = "agent-wall.pending"; // the agent a drop just added
const DROP = "agent-wall.drop"; // the tile whose × was pressed
const AT = "agent-wall.at"; // when the last toggle was taken, so copies don't flip twice
const SEEN = "agent-wall.seen"; // the terminal the wall last settled on (shared: a click remounts this mod)
const PLACE = "agent-wall.place"; // the space|tab the wall stood on (a pick elsewhere leaves it)
const NAME = "agent-wall";
const FILE = () => `${appHome()}/layouts/${NAME}.json`;
// A layout's name is also a file name: a value in shared state is used only when it is one, and
// when it is a name at all — "." and ".." are not, and would read one level up.
const layoutName = (value) => (/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(String(value ?? "")) ? String(value) : "main-gh");

const clone = (v) => JSON.parse(JSON.stringify(v));

// A space or agent can name itself, and a name can carry bidi overrides: it never reaches
// the chip itself, only its tooltip, and there stripped.
const plain = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

// The chip's block, for a layout that has no top bar to hold it.
const CHIP = () => ({ id: "wall-chip", type: "block", size: { px: 132 }, padding: [7, 0], content: { mod: NAME } });

// Does this tree already hold the chip? Then nothing is added: the top bar's layout has
// its own, and a second one would draw the same chip twice.
function hasChip(node) {
  if (!node || typeof node !== "object") return false;
  if (node.content?.mod === NAME) return true;
  return [...(node.children ?? []), ...(node.floating ?? [])].some(hasChip);
}

// One agent's mark in the chip: its program's own icon, or its first letter in that
// program's colour, so the chip is read by the marks people already know.
function programTile(agent, t, size) {
  const program = agent.program ?? {};
  const name = plain(agent.space_name) || plain(program.name) || "agent";
  const ink = program.color || (program.tile ? "#ffffff" : t.foreground);
  return h_flex().size(size).flex_none().rounded(4).items_center().justify_center()
    .bg(program.tile ?? t.raised)
    .tooltip(`${name} \u00b7 ${agent.status ?? "idle"}`)
    .when(Boolean(program.icon), (el) => el.child(program.tint
      ? svg(program.icon).size(size - 2).text_color(ink)
      : image(program.icon).size(size)))
    .when(!program.icon, (el) => el.child(div().text_size(10.5).font_semibold().text_color(ink)
      .child((plain(program.name) || name).slice(0, 1).toUpperCase() || "\u00b7")));
}

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) { const hit = find(child, id); if (hit) return hit; }
  for (const float of node.floating ?? []) { const hit = find(float, id); if (hit) return hit; }
  return null;
}

// Replaces a node by id, wherever it sits; returns the tree it was given.
function replace(node, id, next) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node.children)) node.children = node.children.map((child) => (child?.id === id ? next : child));
  for (const child of node.children ?? []) replace(child, id, next);
  return node;
}

export default class AgentWall extends View {
  init(_props, cx) {
    this.sig = shared(SIG) ?? ""; // a copy born by a switch already shows this set
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle") this.toggle(cx);
        else if (command === "active") this.active(cx);
        else if (command === "all") this.all(cx);
        else if (command === "on") this.on(cx);
        else if (command === "off") this.off(cx);
        else if (command === "pair") this.pair(cx);
        else if (command === "remove") this.remove(cx);
        cx.notify();
      }
    });
    // A wall left on by a restart holds dead addresses, and agents load a moment
    // later: rewrite it when they arrive, and give up on the wall if none does.
    this.tries = 0;
    this.damaged = 0;
    // Left by a switch (ctrl-shift-l, the palette) rather than the toggle: the person chose
    // to leave the wall, so it must not rebuild itself the next time this layout shows.
    if (shared(ON) && shared("layout") !== NAME) {
      setShared(SEEN, null);
      setShared(PLACE, null);
      setShared(BASE, null);
      setShared(SIG, "");
      setShared(ON, false);
    }
    if (shared(ON)) this.on(cx);
    // A wall left showing with no wall behind it — a write that failed, a restart that
    // overtook the state — draws no tab at all: the window is empty. Come back to the
    // layout the wall stood in for, and rewrite a wall whose file lost a terminal.
    if (shared("layout") === NAME) {
      if (!shared(ON)) this.off(cx);
      else if (!this.intact()) { setShared(SIG, ""); this.on(cx); }
    }
    cx.timer.every(600, (cx) => {
      // A drop sets the address and calls `pair`; if that command raced the write, this
      // still takes it.
      if (shared(PENDING)) { this.pair(cx); return; }
      if (!shared(ON)) return;
      // The person picked a place other than the one the wall stood on — a tab, an agent, a
      // space, by click, key or palette: the wall gives way to it, before anything can
      // rebuild the wall around it. The mods' own clicks ask for this directly, so a pick
      // that changes nothing (the tab already shown, an agent that is already a tile) still
      // leaves; every other route changes the place and lands here.
      if (leftWall(shared(PLACE) ?? null, place(focused()))) { this.off(cx); return; }
      // The app drops a block whose terminal went away, and a head left without one is an
      // empty column: write the wall again, whatever has the keyboard. A wall it keeps
      // emptying is one that cannot be shown, so leave it rather than rewrite forever.
      if (!this.intact()) {
        if (++this.damaged > 3) { this.off(cx); return; }
        setShared(SIG, ""); this.on(cx); return;
      }
      this.damaged = 0;
      // Picking an agent remounts this mod, so what the wall last settled on lives in
      // shared state, not in a copy. Unset means "settle now": entering can leave the
      // keyboard on a pane the wall does not show, and that must not leave at once.
      const here = focused()?.terminal ?? null;
      const seen = shared(SEEN) ?? null;
      if (!seen) {
        // Only a terminal settles it: a mod holding the keyboard says nothing about which
        // agent the person is on, and settling on nothing would disarm the leave check.
        if (here) { setShared(SEEN, here); return; }
      } else if (shared("layout") === NAME) {
        // A terminal that is not one of the wall's has the keyboard: the person picked that
        // agent (its row in the sidebar, its tab), so the wall gives way to it — the chip
        // stays, one click from the wall again.
        const shown = (shared(SIG) ?? "").split(",").filter(Boolean);
        if (here && here !== seen && !shown.includes(here) && agents().some((a) => a.address === here)) {
          this.off(cx);
          return;
        }
        if (here && here !== seen) setShared(SEEN, here);
      }
      // Compare with what the file was written for, not with this copy's idea: a copy born
      // by the switch starts with the same set and must not rewrite the layout again.
      const sig = this.desired().map((a) => a.address).join();
      if (sig === (shared(SIG) ?? "")) { this.tries = 0; return; }
      if (++this.tries > 6) { this.off(cx); return; }
      this.on(cx);
    });
  }

  // Every copy of this mod hears the command (a rebuilt layout can leave more than one
  // alive): the first one through acts, the rest skip, so one key = one flip.
  toggle(cx) {
    if (!this.once()) return;
    if (shared(ON)) this.off(cx);
    else this.on(cx);
  }

  // One flip per gesture, however many copies are alive: a rebuilt layout can leave more
  // than one, and a key reaches every copy.
  once() {
    const now = Date.now();
    if (now - (shared(AT) ?? 0) < 300) return false;
    setShared(AT, now);
    return true;
  }

  // The chip's right segment: the agents working or blocked now, frozen at this click.
  // Asking again while that wall shows leaves it, as the key does.
  active(cx) {
    if (!this.once()) return;
    if (shared(ON) && shared(MODE) === "active") { this.off(cx); return; }
    const list = activeAddresses(agents());
    if (list.length < 2) {
      notify({ title: "Wall", body: list.length ? "One agent is working: an active wall needs two" : "No agent is working or blocked", level: "info" });
      return;
    }
    // The list first: the mode alone would be a filter with nothing frozen, and a
    // half-written pair must never read as "every agent" (`pinned` keeps it empty).
    setShared(FEAT, list);
    setShared(MODE, "active");
    setShared(SIG, "");
    this.sig = "";
    this.on(cx);
  }

  // The chip's left segment: every agent, or the set a drag composed. Asking again while
  // that wall shows leaves it; asking it while a filtered wall shows swaps the filter out.
  all(cx) {
    if (!this.once()) return;
    if (shared(ON) && shared(MODE) !== "active") { this.off(cx); return; }
    setShared(MODE, null);
    setShared(SIG, "");
    this.sig = "";
    this.on(cx);
  }

  // The base tree, or the layout tree the wall was first built from.
  base() {
    const saved = shared(BASE);
    if (saved) return clone(saved);
    const shown = clone(layout());
    if (shared("layout") === NAME) return null;
    setShared(BASE, shown);
    setShared(BACK, shared("layout"));
    return shown;
  }

  // Put an agent beside the one showing now: what a drop on the terminal area does.
  // `PENDING` carries the address (a mod command takes no arguments).
  pair(cx) {
    const pending = shared(PENDING);
    setShared(PENDING, null);
    if (!pending) return;
    const here = spaces().find((s) => s.active);
    const now = agents().find((a) => a.focused)?.address
      ?? agents().find((a) => a.space === here?.id)?.address;
    const list = [...new Set([...(shared(LIST) ?? []), ...(now ? [now] : []), pending])];
    if (list.length < 2) {
      notify({ title: "Wall", body: "Drag another agent's row here", level: "info" });
      return;
    }
    setShared(MODE, null); // a drop composes a wall; it never filters one
    setShared(LIST, list);
    setShared(SIG, "");
    this.sig = "";
    this.on(cx);
  }

  // What the wall shows, and what its chip offers: the agents a gesture picked, or the ones
  // a click froze as active, in that order; every agent when nothing was picked or too few
  // of the picked ones survive (their addresses die with the agent, and a restart keeps the
  // set). A filter never widens — `on` refuses it instead.
  desired() {
    return wallSet(agents(), shared(MODE) ?? null, shared(FEAT) ?? null, shared(LIST) ?? null);
  }

  // Is the wall on screen the one the set asks for? Its columns show a head per agent and
  // the terminal under it; a column whose terminal went away (the app drops such a block)
  // is an empty column, and a tree with no wall in it is a switch still landing, which the
  // next look judges.
  intact() {
    const root = layout();
    const main = find(root, "main");
    const columns = (main?.children ?? []).filter((child) => String(child?.id ?? "").startsWith("wall-"));
    if (!columns.length) return true;
    return columns.every((column) => (column?.children ?? []).some((child) => child?.content?.terminal));
  }

  // A tile's ×: that agent leaves the wall; the last one turns it back into tabs.
  remove(cx) {
    const address = shared(DROP);
    setShared(DROP, null);
    if (!address) return;
    // Whichever set is showing: the frozen one while the wall is a filter, else the picked one.
    const key = shared(MODE) === "active" ? FEAT : LIST;
    const chosen = shared(key);
    const list = (Array.isArray(chosen) ? chosen : agents().map((a) => a.address)).filter((a) => a !== address);
    setShared(SIG, "");
    this.sig = "";
    if (list.length <= 1) {
      setShared(key, null);
      if (key === FEAT) setShared(MODE, null);
      this.off(cx);
      return;
    }
    setShared(key, list);
    this.on(cx);
  }

  on(cx) {
    // A filter that lost its agents is spent: with the wall down it is dropped here, so the
    // next press opens the wall of every agent instead of refusing with a stale count. While
    // the wall is up the set stays small, and the refusal below leaves it.
    const chose = rebuild(agents(), shared(MODE) ?? null, shared(FEAT) ?? null, shared(LIST) ?? null, Boolean(shared(ON)));
    if (chose.spent && shared(MODE) === "active") {
      setShared(FEAT, null);
      setShared(MODE, null);
    }
    const list = chose.set;
    if (list.length < 2) {
      // A wall of one is not a wall: say why when nothing is showing, and never leave one
      // on screen (its chip would be the only way out, and it would be a wall of one).
      if (shared(ON)) { this.off(cx); return; }
      notify({ title: "Wall", body: list.length ? "One agent is running: a wall needs two" : "No agent is running", level: "info" });
      return;
    }
    const sig = list.map((a) => a.address).join();
    // A set only ever names agents that exist: dead addresses are dropped here, and fewer
    // than two left means the wall goes back to tracking every agent — or, for a filter,
    // back to no filter at all, since a wall of fewer than two is refused just below.
    const key = shared(MODE) === "active" ? FEAT : LIST;
    const chosen = shared(key);
    if (Array.isArray(chosen)) {
      const wanted = new Set(list.map((a) => a.address));
      const kept = [...new Set(chosen)].filter((address) => wanted.has(address));
      if (kept.length < 2) {
        setShared(key, null);
        if (key === FEAT) setShared(MODE, null);
      } else if (kept.join() !== chosen.join()) setShared(key, kept);
    }
    // Already showing this set, and the file was written for it (a restart rebuilds).
    if (shared(ON) && shared(SIG) === sig && shared("layout") === NAME) return;
    const root = this.base();
    const main = root && (find(root, "main") ?? null);
    // Nothing to build the wall from (a restart lost the base, or the layout has no main
    // area): staying on the wall would leave the window empty, so go back to tabs.
    if (!main) {
      if (shared("layout") === NAME) this.off(cx);
      return;
    }
    const keep = { id: main.id };
    for (const key of ["size", "min", "max", "hidden"]) if (main[key] !== undefined) keep[key] = main[key];
    replace(root, main.id, {
      ...keep,
      type: "row",
      gap: 6,
      children: list.map((a) => ({
        id: `wall-${a.address}`,
        type: "column",
        gap: 4,
        children: [
          { id: `wall-head-${a.address}`, type: "block", size: { px: 26 }, content: { mod: "wall-tile", props: { terminal: a.address } } },
          { id: `wall-term-${a.address}`, type: "block", content: { terminal: a.address } },
        ],
      })),
    });
    // The chip that leads back. A layout this mod runs in always mounts it somewhere (that
    // is how this code runs at all); a tree without one — an older saved base, or a layout
    // whose chip was removed — gets it in its status row, where it is still reachable.
    if (!hasChip(root)) {
      const status = find(root, "status");
      if (status?.children) status.children.splice(1, 0, CHIP());
    }
    this.sig = sig;
    this.tries = 0;
    // The place the wall stands on, for a pick to leave from. Only an entry writes it: a
    // rebuild while the wall is up (an agent started or finished) must not re-anchor it
    // under a person who has already navigated.
    if (!shared(ON) || shared("layout") !== NAME) setShared(PLACE, place(focused()));
    setShared(SEEN, null); // settle on the next look, whatever has the keyboard then
    setShared(SIG, sig);
    setShared(ON, true);
    cx.spawn(async (cx) => {
      try {
        // The terminal menu is the layout root's choice; the wall has its own file, so
        // copy it from the layout it stands in for (read from disk: always current).
        const back = JSON.parse((await readTextFile(`${appHome()}/layouts/${layoutName(shared(BACK))}.json`).catch(() => null)) ?? "null");
        if (back?.terminal_menu) root.terminal_menu = back.terminal_menu;
        // null creates a file; an existing one must be replaced from its current text.
        const prev = await readTextFile(FILE()).catch(() => null);
        await writeTextFile(FILE(), JSON.stringify(root, null, 2), prev);
        // Leaving while the file was being written must win: switching here would show a
        // wall whose state says it is off.
        if (!shared(ON)) return;
        run("layout.switch", { name: NAME });
      } catch (e) {
        // Two copies can write the same wall at once and one write loses: the file that
        // won is this wall when it holds every agent's terminal. Any other failure leaves
        // a window with no tab in it, so go back to tabs rather than stand on it.
        const text = String((await readTextFile(FILE()).catch(() => null)) ?? "");
        if (!list.every((a) => text.includes(`wall-term-${a.address}`))) {
          notify({ title: "Wall", body: `Could not write the wall: ${e?.message ?? e}`, level: "error" });
          this.off(cx);
          return;
        }
      }
      cx.notify();
    });
  }

  off(cx) {
    this.sig = "";
    setShared(SEEN, null);
    setShared(PLACE, null);
    setShared(BASE, null); // the next wall reads the layout again (it may have changed)
    setShared(SIG, "");
    // LIST stays: it is what the chip remembers, and what a click on it brings back.
    setShared(ON, false);
    run("layout.switch", { name: layoutName(shared(BACK)) });
    cx.notify();
  }

  // The wall's chip, wherever a layout mounts it visibly: two halves that open the wall of
  // every agent and the wall of the ones working or blocked — the pair `mods/tabs-gh` draws
  // in the tab strip, with room here for the agents' program tiles.
  render() {
    const t = theme();
    const on = Boolean(shared(ON));
    const mode = shared(MODE) ?? null;
    const list = this.desired();
    const active = activeAddresses(agents());
    const blocked = active.some((a) => a.status === "blocked");
    const allOn = on && mode !== "active";
    const actOn = on && mode === "active";
    const tiles = mode === "active" ? [] : list.slice(0, 2);
    const more = mode === "active" ? 0 : list.length - tiles.length; // no tiles while filtered
    const name = (a) => `\u00b7 ${plain(a.space_name) || plain(a.app) || "agent"} \u00b7 ${a.status ?? "idle"}`;
    const allWhy = allOn ? "click to return to tabs"
      : list.length >= 2 ? (actOn ? "click to show every agent" : "click to show them")
        : list.length === 1 ? "needs two agents \u2014 one is running" : "needs two agents \u2014 no agent is running";
    const allTip = [`Wall: ${list.length || "no"} agent${list.length === 1 ? "" : "s"} side by side \u2014 ${allWhy}`,
      ...list.map(name)].join("\n");
    const actWhy = actOn ? "click to return to tabs"
      : active.length >= 2 ? "click to show them"
        : active.length === 1 ? "needs two active agents \u2014 one is working" : "needs two active agents \u2014 none is working";
    const actTip = [`Active wall: ${active.length || "no"} working or blocked \u2014 ${actWhy}`,
      ...active.map(name)].join("\n");
    const allLive = allOn || list.length >= 2;
    const actLive = actOn || active.length >= 2;
    const half = (id, tip, live, showing, action, children) => h_flex().id(id).h(24).px(6).gap(5).items_center().rounded(6)
      .tooltip(tip)
      .when(showing, (el) => el.bg(t.chrome))
      .when(live, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }))
      .children(children);
    const chip = h_flex().id("agent-wall").size_full().px(2).gap(1).items_center().justify_center().rounded(7)
      .bg(on ? t.selected : t.chrome)
      .border(1).border_color(on ? t.accent : t.chrome);
    // One agent is not a wall: the chip says why it is inert instead of opening one — but a
    // wall already showing is always dismissable from its chip.
    if (list.length < 2 && !on) {
      return chip.child(div().truncate().px(4).text_size(11.5).text_color(t.muted)
        .child(list.length ? "1 agent" : "no agents"));
    }
    return chip
      .child(half("aw-all", allTip, allLive, allOn, (cx) => this.all(cx), [
        svg("mods/agent-wall/wall.svg").size(13).text_color(on ? t.accent : t.muted),
        ...tiles.map((agent) => programTile(agent, t, 14)),
        ...(more > 0 ? [div().text_size(11).flex_none().text_color(t.muted).child(`+${more}`)] : []),
        div().text_size(12).flex_none().text_color(allOn ? t.foreground : t.muted).child(String(list.length)),
      ]))
      .child(div().w(1).h(14).flex_none().bg(t.border))
      .child(half("aw-active", actTip, actLive, actOn, (cx) => this.active(cx), [
        div().size(7).flex_none().rounded(4).bg(active.length ? (blocked ? t.blocked : t.working) : t.dim)
          .when(actOn, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 })),
        div().text_size(11.5).flex_none().text_color(actOn ? t.foreground : t.muted).child(`${active.length} active`),
      ]));
  }
}
