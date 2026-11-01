import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover } from "gpui-base";
import { exec, home, theme, run, spaces, knownAgents, props, closeOverlay, shared, setShared, pickFolder } from "herdr";

// Two ways in:
//   mode "item" (from an issue or PR): the branch and the worktree start as its
//     name; pick the agent and go.
//   mode "repo" (from the panel's New button): pick a repo (or another folder,
//     initialized as a repository when it isn't one), a branch that exists or a
//     new one, and the agent.
// The agent picked last is remembered in shared("gh-board.agent").
const slug = (name) => String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

function folderName(folder) {
  return slug(String(folder ?? "").split("/").filter(Boolean).pop() || "repo");
}

function trimmed(value, limit) {
  const text = slug(value);
  return text.length > limit ? text.slice(0, limit).replace(/-+$/, "") : text;
}

// "#53 Worktree rows, per-tree tabs" -> "53-worktree-rows-per-tree-tabs"
function issueName(number, label) {
  if (number == null) return "";
  const title = String(label ?? "").replace(new RegExp(`^#?${number}[\\s:.-]*`), "");
  return trimmed(`${number}-${title}`, 48);
}

function scanned() {
  const list = shared("gh-board.repos");
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => (typeof entry === "string" ? { repo: entry, dir: null } : entry))
    .filter((entry) => entry && entry.repo);
}

const savedAgent = () => (typeof shared("gh-board.agent") === "string" ? shared("gh-board.agent") : null);

export default class GhNew extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.mode = p.mode === "repo" ? "repo" : "item";
    this.repo = String(p.repo ?? "");
    this.folder = String(p.folder ?? "");
    this.label = String(p.label ?? "");
    this.tabName = String(p.tab ?? p.label ?? "");
    this.agents = null;
    this.agent = null; // index into agents, -1 for a plain shell
    this.agentOpen = false;
    this.repoOpen = false;
    this.branchOpen = false;
    this.branches = null;
    this.isRepo = null; // repo mode: whether the chosen folder is already a git repository
    this.busy = false;
    this.error = "";

    // An issue or PR names the branch; from scratch the repo does.
    const named = this.mode === "item" ? issueName(p.number, this.label) : "";
    this.worktree = named || folderName(this.folder);
    this.branch = named || folderName(this.folder);

    this.worktreeInput = InputState.new({ value: this.worktree, placeholder: "worktree name" });
    this.branchInput = InputState.new({ value: this.branch, placeholder: "branch name" });
    this.worktreeInput.on("change", (_e, cx) => { this.worktree = this.worktreeInput.value(); this.error = ""; cx.notify(); });
    this.branchInput.on("change", (_e, cx) => { this.branch = this.branchInput.value(); this.error = ""; cx.notify(); });
    this.worktreeInput.on("submit", (_e, cx) => this.create(cx));
    this.branchInput.on("submit", (_e, cx) => this.create(cx));
    if (this.mode === "item") {
      this.worktreeInput.focus();
      cx.timer.after(500, () => this.worktreeInput.focus());
    }

    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents()).filter((agent) => agent.installed); }
      catch { this.agents = []; }
      const wanted = savedAgent();
      const at = wanted ? this.agents.findIndex((agent) => (agent.name ?? "") === wanted || agent.run.join(" ") === wanted) : -1;
      this.agent = wanted === "shell" ? -1 : at >= 0 ? at : this.agents.length ? 0 : -1;
      cx.notify();
    });

    if (this.mode === "repo") this.loadBranches(cx);
  }

  base() {
    return `${home()}/.herdr/worktrees/${folderName(this.folder)}`;
  }

  path() {
    return `${this.base()}/${slug(this.worktree) || "worktree"}`;
  }

  agentName() {
    if (!this.agents || this.agent == null || this.agent < 0) return "Shell";
    return this.agents[this.agent]?.name ?? this.agents[this.agent]?.run.join(" ") ?? "Shell";
  }

  agentRun() {
    if (!this.agents || this.agent == null || this.agent < 0) return null;
    return this.agents[this.agent]?.run ?? null;
  }

  pickAgent(index, cx) {
    this.agent = index;
    this.agentOpen = false;
    setShared("gh-board.agent", index < 0 ? "shell" : this.agents?.[index]?.name ?? null);
    cx.notify();
  }

  loadBranches(cx) {
    const folder = this.folder;
    if (!folder) return;
    this.branches = null;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["-C", folder, "rev-parse", "--show-toplevel"]);
        this.isRepo = top.code === 0;
        if (top.code !== 0) { this.branches = []; return; }
        const list = await exec("git", ["-C", top.stdout.trim(), "branch", "--format=%(refname:short)", "--sort=-committerdate"]);
        this.branches = list.code === 0 ? list.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
      } catch {
        this.isRepo = false;
        this.branches = [];
      }
      cx.notify();
    });
  }

  pickRepo(entry, cx) {
    this.repoOpen = false;
    this.repo = entry?.repo ?? "";
    this.folder = entry?.dir ?? "";
    const name = folderName(this.folder);
    this.worktree = name;
    this.branch = name;
    this.worktreeInput.set_value(name);
    this.branchInput.set_value(name);
    this.error = "";
    this.loadBranches(cx);
    cx.notify();
  }

  async otherFolder(cx) {
    this.repoOpen = false;
    cx.notify();
    try {
      const folder = await pickFolder({ prompt: "Use this folder" });
      if (folder) this.pickRepo({ repo: folderName(folder), dir: folder }, cx);
    } catch (e) {
      this.error = String(e?.message || e);
      cx.notify();
    }
  }

  create(cx) {
    if (this.busy) return;
    const worktree = slug(this.worktree), branch = String(this.branch ?? "").trim();
    if (!this.folder) return this.fail("Pick a repo first.", cx);
    if (!worktree) return this.fail("Name the worktree.", cx);
    if (!branch) return this.fail("Name the branch.", cx);
    const path = this.path();
    const agent = this.agentRun();
    const tab = this.tabName || branch;
    this.busy = true;
    this.error = "";
    cx.spawn(async (cx) => {
      try {
        const existing = spaces().find((space) => space.folder === path);
        if (existing) {
          run("space.select", { id: existing.id });
          const args = { space: existing.id, folder: path, name: tab };
          if (agent) args.argv = agent;
          run("tab.new", args);
          closeOverlay(props().overlay);
          return;
        }
        const found = await exec("git", ["-C", this.folder, "rev-parse", "--show-toplevel"]);
        let root = found.code === 0 ? found.stdout.trim() : null;
        if (!root) {
          // A folder that is not a repository yet: make one, so "from zero" works.
          const init = await exec("git", ["init", "-b", "main", this.folder]);
          if (init.code !== 0) throw new Error((init.stderr || "git init failed").trim().split("\n").pop());
          const commit = await exec("git", ["-C", this.folder, "commit", "--allow-empty", "-m", "Start"]);
          if (commit.code !== 0) throw new Error((commit.stderr || "git commit failed").trim().split("\n").pop());
          root = this.folder;
        }
        const known = await exec("git", ["-C", root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
        const add = known.code === 0 ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, "HEAD"];
        const made = await exec("git", ["-C", root, ...add]);
        if (made.code !== 0) throw new Error((made.stderr || made.stdout || "git worktree add failed").trim().split("\n").pop());
        // Named after the repo: the checkout is what varies, the project is not.
        const args = { name: folderName(root), folder: path, machine: null, tab };
        if (agent) args.argv = agent;
        run("space.new", args);
        closeOverlay(props().overlay);
      } catch (e) {
        this.error = String(e?.message || e);
        this.busy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  fail(message, cx) {
    this.error = message;
    cx.notify();
  }

  box(input, t) {
    return div().flex_1().min_w(0).h(30).px(9).flex().items_center().rounded(7).bg(t.chrome)
      .border_1().border_color(t.input).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(input).h_full().text_size(12).text_color(t.foreground));
  }

  field(label, input, t) {
    return h_flex().gap(8).items_center()
      .child(div().w(70).flex_none().text_size(11).text_color(t.muted).child(label))
      .child(this.box(input, t));
  }

  trigger(id, label, open, t) {
    return div().id(id).h(30).flex_1().min_w(0).px(9).flex().items_center().gap(6).rounded(7).bg(t.chrome)
      .border_1().border_color(open ? t.accent : t.input).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(label))
      .child(div().text_size(9).text_color(t.dim).child("▾"));
  }

  menu(id, rows, t) {
    const height = Math.min(260, Math.max(34, rows.length * 27 + 8));
    return v_flex().id(id).w(250).h(height).p(4).gap(1).rounded(8).bg(t.popover)
      .border_1().border_color(t.border).shadow_lg().text_size(11.5)
      .overflow_y_scrollbar().children(rows);
  }

  agentMenu(t, cx) {
    const rows = [this.menuRow("gh-agent-shell", "Shell", null, this.agent === -1, t, () => this.pickAgent(-1, cx))];
    for (const [index, agent] of (this.agents ?? []).entries()) {
      rows.push(this.menuRow(`gh-agent-${index}`, agent.name ?? agent.run.join(" "), agent, this.agent === index, t, () => this.pickAgent(index, cx)));
    }
    if (!this.agents) rows.push(div().p(6).text_size(11).text_color(t.dim).child("Looking…"));
    return this.menu("gh-agent-menu", rows, t);
  }

  menuRow(id, label, program, selected, t, onClick) {
    return h_flex().id(id).h(26).flex_none().px(7).gap(7).items_center().rounded(6).cursor_pointer()
      .bg(selected ? t.selected : t.popover).text_color(selected ? t.foreground : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_click(onClick)
      .when(Boolean(program?.icon), (e) => e.child(program.tint ? svg(program.icon).size(13).text_color(t.muted) : image(program.icon).size(13)))
      .child(div().flex_1().min_w(0).truncate().child(label))
      .when(selected, (e) => e.child(svg("mods/gh-new/check.svg").size(11).text_color(t.accent)));
  }

  repoMenu(t, cx) {
    const rows = scanned().map((entry) => this.menuRow(`gh-repo-${entry.repo}`, entry.repo, null, entry.dir === this.folder, t, () => this.pickRepo(entry, cx)));
    rows.push(this.menuRow("gh-repo-other", "Other folder…", null, false, t, () => this.otherFolder(cx)));
    if (!rows.length) rows.push(div().p(6).text_size(11).text_color(t.dim).child("No repos scanned yet."));
    return this.menu("gh-repo-menu", rows, t);
  }

  branchMenu(t, cx) {
    const list = this.branches ?? [];
    const rows = list.slice(0, 200).map((name) => this.menuRow(`gh-branch-${name}`, name, null, name === this.branch, t, () => {
      this.branchOpen = false;
      this.branch = name;
      this.worktree = slug(name);
      this.branchInput.set_value(name);
      this.worktreeInput.set_value(this.worktree);
      cx.notify();
    }));
    if (!list.length) rows.push(div().p(6).text_size(11).text_color(t.dim).child("No branches: a new one starts from scratch."));
    return this.menu("gh-branch-menu", rows, t);
  }

  render(cx) {
    const t = theme();
    const framed = !props()?.overlay;
    const repo = this.mode === "repo" ? (this.repo || "Choose a repo") : this.repo;
    const branchRows = this.branches ?? [];

    return v_flex().w_full().p(14).gap(10).text_color(t.foreground).text_size(12.5)
      .when(framed, (e) => e.rounded(12).bg(t.popover).border_1().border_color(t.border).shadow_lg())
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("Worktree + agent"))
        .child(div().flex_1())
        .child(div().text_size(10.5).text_color(t.dim).child(this.mode === "repo" ? "from scratch" : this.repo)))
      .when(this.mode === "item" && Boolean(this.label), (e) => e.child(div().text_size(11.5).text_color(t.muted).truncate().child(this.label)))
      .when(this.mode === "repo", (e) => e.child(h_flex().gap(8).items_center()
        .child(div().w(70).flex_none().text_size(11).text_color(t.muted).child("Repo"))
        .child(Popover.new("gh-repo-pop").trigger(this.trigger("gh-repo-trigger", repo, this.repoOpen, t))
          .anchor("bottom_left").open(this.repoOpen)
          .on_open_change((open, cx) => { this.repoOpen = open; cx.notify(); })
          .content(this.repoMenu(t, cx)))))
      .child(this.field("Worktree", this.worktreeInput, t))
      .child(div().text_size(10).text_color(t.dim).child(this.folder ? `→ ${this.path()}` : "Pick a repo to see where it goes."))
      .child(h_flex().gap(8).items_center()
        .child(div().w(70).flex_none().text_size(11).text_color(t.muted).child("Branch"))
        .child(this.box(this.branchInput, t))
        .when(this.mode === "repo", (e) => e.child(Popover.new("gh-branch-pop")
          .trigger(div().id("gh-branch-trigger").h(30).px(8).flex().items_center().rounded(7).bg(t.chrome).cursor_pointer()
            .border_1().border_color(this.branchOpen ? t.accent : t.input).hover((s) => s.bg(t.hover))
            .child(div().text_size(10.5).text_color(t.muted).child(branchRows.length ? `▾ ${branchRows.length}` : "▾")))
          .anchor("bottom_right").open(this.branchOpen)
          .on_open_change((open, cx) => { this.branchOpen = open; cx.notify(); })
          .content(this.branchMenu(t, cx)))))
      .child(div().text_size(10).text_color(t.dim)
        .child(this.mode === "repo" && this.isRepo === false
          ? "Not a repository yet: it is initialized and the branch starts there."
          : "An existing branch is checked out; a new one starts from HEAD."))
      .child(h_flex().gap(8).items_start()
        .child(div().w(70).flex_none().pt(4).text_size(11).text_color(t.muted).child("Agent"))
        .child(Popover.new("gh-agent-pop")
          .trigger(this.trigger("gh-agent-trigger", this.agentName(), this.agentOpen, t))
          .anchor("bottom_left").open(this.agentOpen)
          .on_open_change((open, cx) => { this.agentOpen = open; cx.notify(); })
          .content(this.agentMenu(t, cx))))
      .when(Boolean(this.error), (e) => e.child(div().text_size(11).text_color(t.ansi1).child(this.error)))
      .child(h_flex().gap(8).items_center().pt(2)
        .child(div().flex_1().min_w(0).truncate().text_size(10).text_color(t.dim).child(this.tabName || this.branch || ""))
        .child(div().id("gh-new-cancel").h(26).px(12).flex().items_center().rounded(7).text_size(11.5).cursor_pointer()
          .bg(t.raised).text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => closeOverlay(props().overlay)).child("Cancel"))
        .child(div().id("gh-new-create").h(26).px(14).flex().items_center().rounded(7).text_size(11.5).cursor_pointer()
          .bg(this.busy ? t.raised : t.solid).text_color(this.busy ? t.dim : t.solid_foreground)
          .on_click((_e, cx) => this.create(cx)).child(this.busy ? "Creating…" : "Create")));
  }
}
