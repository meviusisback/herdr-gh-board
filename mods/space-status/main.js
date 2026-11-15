import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, panes, theme, exec, focused, layout } from "herdr";

// The bottom-left corner: the machine, and the repo the agents on screen are in. How many
// agents run is the spaces panel's business now: every branch row there says what hangs under
// it and starts the next one. The repo is the one those agents share — the shown tab's panes,
// every terminal block the layout draws (that is how the Wall shows several agents at once) and
// an agent block's agent — named after the repo's main checkout, so a worktree still names its
// repo.
// Agents in two different repos leave the chip out, and so does a branch only some of them are
// on: the bar says what they agree on, and nothing where it would have to pick one.
const RECHECK_NOREPO = 60000; // a folder git says is no repo is asked again after this long
const RECHECK_FAILED = 30000; // a git that could not answer (timeout, no remote) likewise

export default class WorkspaceStatus extends View {
  init(_props, cx) {
    this.repos = {}; // `${on ?? ""}|${folder}` -> { root, at }: the folder of its main checkout
    this.busy = false;
    // Focus, tabs and agents arrive as live data (a render of their own); only the git answer
    // is ours to fetch, so the timer looks for folders nothing has named yet and does no more.
    cx.timer.every(1000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  // The agents on screen, as the folder and branch of their own terminal — what the chip talks
  // about. Agents Herdr shows without a pane (the Wall's tiles, a sub-agent) fall back to their
  // space's folder, and to its machine for anything read there.
  onScreen() {
    const all = panes();
    const tab = focused()?.tab ?? null;
    const shown = new Set();
    let agentBlock = false;
    const walk = (node) => {
      if (!node || typeof node !== "object" || node.hidden === true) return;
      const content = node.content ?? {};
      if (typeof content.tab === "string") {
        // A tab's every pane is on screen, unless one is zoomed: then only that one is.
        const zoomed = all.find((p) => p.tab === tab && p.zoomed && p.terminal);
        if (zoomed) shown.add(zoomed.terminal);
        else for (const pane of all) if (pane.tab === tab && pane.terminal) shown.add(pane.terminal);
      } else if (typeof content.terminal === "string") {
        shown.add(content.terminal);
      }
      if (content.agent) agentBlock = true;
      const children = Array.isArray(node.children) ? node.children : [];
      if (node.type === "stack") {
        for (const child of children) if (child?.id === node.active) walk(child);
      } else for (const child of children) walk(child);
      for (const over of Array.isArray(node.floating) ? node.floating : []) walk(over);
    };
    walk(layout());
    const list = agents().filter((agent) => shown.has(agent.address));
    const chosen = focused()?.agent;
    if (agentBlock && chosen) {
      const one = agents().find((agent) => agent.address === chosen);
      if (one && !list.includes(one)) list.push(one);
    }
    // One pane scan and one space scan for the whole list, not one per agent.
    const paneOf = new Map();
    for (const pane of all) if (!paneOf.has(pane.terminal)) paneOf.set(pane.terminal, pane);
    const spaceOf = new Map(spaces().map((s) => [s.id, s]));
    return list.map((agent) => {
      const pane = paneOf.get(agent.address) ?? null;
      const space = spaceOf.get(agent.space) ?? null;
      return {
        key: `${space?.machine ?? ""}|${pane?.cwd ?? space?.folder ?? ""}`,
        folder: pane?.cwd ?? space?.folder ?? null,
        branch: pane?.branch ?? null,
        on: space?.machine ?? undefined,
      };
    });
  }

  // One `git` call per folder, in a copy's lifetime unless it came back empty-handed. Cached by
  // machine too: the same path on this computer and on a remote one is two different repos.
  refresh(cx) {
    const wanted = [];
    for (const entry of this.onScreen()) {
      const seen = this.repos[entry.key];
      if (!entry.folder) continue;
      if (seen && (seen.root || Date.now() - seen.at < (seen.asked ? RECHECK_NOREPO : RECHECK_FAILED))) continue;
      if (!wanted.some((w) => w.key === entry.key)) wanted.push(entry);
    }
    if (this.busy || !wanted.length) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      for (const entry of wanted) {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          cwd: entry.folder, on: entry.on, timeout: 8000,
        }).catch(() => null);
        const common = String(r?.stdout ?? "").trim().replace(/\/+$/, "");
        const asked = Boolean(r) && r.code === 0;
        this.repos[entry.key] = { root: asked && common.endsWith("/.git") ? common.slice(0, -5) : "", at: Date.now(), asked };
      }
      this.busy = false;
      cx.notify();
    });
  }

  // The one repo the on-screen agents agree on, or null: nothing to say while a folder is still
  // being looked at, when one of them is in no repo at all, or when they are in different ones.
  repoChip(list = this.onScreen()) {
    if (!list.length) return null;
    const roots = new Set();
    for (const entry of list) {
      const root = this.repos[entry.key]?.root;
      if (!root) return null;
      roots.add(root);
    }
    if (roots.size !== 1) return null;
    const [root] = roots;
    const branches = new Set(list.map((entry) => entry.branch).filter(Boolean));
    return { repo: root.slice(root.lastIndexOf("/") + 1), branch: branches.size === 1 ? [...branches][0] : null };
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.active);
    const label = (icon, text) => h_flex().gap(7).items_center().child(svg(`mods/workspace-chrome/${icon}.svg`).size(14)).child(text);
    // One walk of the layout per render: the chip reads the same list the space does.
    const list = this.onScreen();
    const repo = this.repoChip(list);
    return h_flex().size_full().px(16).gap(20).items_center().bg(t.chrome).border_t(1).border_color(t.border).text_size(13).text_color(t.muted)
      .child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
      .when(Boolean(repo), (el) => el
        .tooltip(`${repo.repo}${repo.branch ? ` at ${repo.branch}` : ""} — the repo the agents on screen are in`)
        .child(h_flex().gap(7).items_center()
          .child(svg("mods/workspace-chrome/branch.svg").size(14))
          .child(div().text_color(t.foreground).child(repo.repo))
          .when(Boolean(repo.branch), (inner) => inner.child(div().text_color(t.muted).child(repo.branch)))))
      .child(div().flex_1());
  }
}
