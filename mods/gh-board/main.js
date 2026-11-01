import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Popup } from "gpui-base";
import { exec, home, theme, openOverlay, run, spaces, shared, setShared, settings } from "herdr";
import * as fs from "fs/promises";

// Open issues and PRs of the GitHub repos under ~/repo (a picked subset of
// them), from `gh api graphql`: one batched query per 20 repos. Hover a row for
// its details; its branch button opens the worktree + agent dialog.
const REFRESH_MS = 60000;
const BATCH = 20;
const MAX_ROWS = 300;
const PR_JSON = "number,title,state,isDraft,author,body,createdAt,updatedAt,labels,reviewDecision,additions,deletions,changedFiles,headRefName,baseRefName,url,mergeable";
const ISSUE_JSON = "number,title,state,author,body,createdAt,updatedAt,labels,url,assignees,milestone";

const isChanges = (item) => item.kind === "pr" && item.review === "CHANGES_REQUESTED";

function relative(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
}

function day(iso) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "";
}

// owner/name from an https://, ssh:// or scp-like github remote.
const slug = (name) => String(name ?? "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

function nwo(url) {
  const match = /github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/*$/.exec(url || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* memory only */ }
}

async function scanRepos(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const found = await Promise.all(dirs.map(async (name) => {
    const dir = `${root}/${name}`;
    try {
      const r = await exec("git", ["-C", dir, "config", "--get", "remote.origin.url"]);
      const repo = r.code === 0 ? nwo(r.stdout.trim()) : null;
      return repo ? { dir, repo } : null;
    } catch { return null; }
  }));
  const seen = new Set();
  return found.filter((entry) => entry && !seen.has(entry.repo) && (seen.add(entry.repo), true));
}

const FIELDS = `
  nameWithOwner
  issues(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url updatedAt author { login } comments { totalCount } labels(first: 4) { nodes { name } } }
  }
  pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url updatedAt isDraft reviewDecision author { login } comments { totalCount } labels(first: 4) { nodes { name } } }
  }`;

function batchQuery(repos) {
  const aliases = repos.map((repo, i) => {
    const [owner, name] = repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${FIELDS} }`;
  });
  return `query { ${aliases.join(" ")} }`;
}

async function fetchBatch(repos) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${batchQuery(repos)}`]);
  let body;
  try { body = JSON.parse(r.stdout); } catch {
    const line = (r.stderr || r.stdout || "gh failed").trim().split("\n").filter(Boolean);
    throw new Error(line[line.length - 1] || "gh failed");
  }
  if (!body || !body.data) throw new Error(body?.errors?.[0]?.message || "gh returned no data");
  return body.data;
}

function toItem(repo, kind, node) {
  return {
    repo, kind,
    key: `${repo}#${node.number}${kind === "pr" ? "p" : ""}`,
    number: node.number,
    title: node.title,
    url: node.url,
    updatedAt: node.updatedAt || "",
    author: node.author?.login || "ghost",
    comments: node.comments?.totalCount ?? 0,
    labels: (node.labels?.nodes ?? []).map((label) => label.name),
    draft: Boolean(node.isDraft),
    review: node.reviewDecision || null,
  };
}

// Mirrors gh-new's naming: "#53 Worktree rows, per-tree tabs" -> 53-worktree-rows-per-tree-tabs
function issueName(number, label) {
  if (number == null) return "";
  const title = String(label ?? "").replace(new RegExp(`^#?${number}[\\s:.-]*`), "");
  const text = slug(title ? `${number}-${title}` : String(number));
  return text.length > 48 ? text.slice(0, 48).replace(/-+$/, "") : text;
}

// Rough chip widths (the ui font is monospace): enough to know whether the four
// fit on one line, with a wrap as the fallback — never an overlap.
const textWidth = (text, size) => String(text).length * size * 0.56;
const chipWidth = (label, count, extra = 0) =>
  18 + textWidth(label, 11) + (count == null ? 0 : 6 + textWidth(count, 10)) + extra;

function openUrl(url) {
  exec("xdg-open", [url]).then((r) => (r.code === 0 ? null : exec("open", [url]))).catch(() => {});
}

export default class GhBoard extends View {
  init(props, cx) {
    this.props = props || {};
    this.repos = null;
    this.items = [];
    this.details = {};
    this.loadingDetail = {};
    this.loading = false;
    this.error = null;
    this.failed = 0;
    this.loadedAt = null;
    this.width = 900;
    this.filter = ["issue", "pr"].includes(stored("gh-board.filter")) ? stored("gh-board.filter") : "all";
    this.hideChanges = stored("gh-board.hideChanges") === "1";
    this.selected = null;
    this.hoverKey = null;
    this.hoverHold = false;
    this.selectedKey = JSON.stringify(shared("gh-board.selected") ?? null);
    this.rootKey = `${shared("gh-board.root") ?? ""}|${shared("gh-board.rescan") ?? 0}`;
    this.refresh(cx, true);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx));
  }

  root() {
    const chosen = shared("gh-board.root");
    if (typeof chosen === "string" && chosen) return chosen;
    const given = this.props && this.props.root;
    return typeof given === "string" && given ? given : `${home()}/repo`;
  }

  refresh(cx, rescan = false) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.repos || rescan) {
          const repos = await scanRepos(this.root());
          if (repos === null) throw new Error(`No folder at ${this.root()}`);
          this.repos = repos;
          // The repo picker and the from-scratch dialog read the list from here.
          if (JSON.stringify(shared("gh-board.repos") ?? null) !== JSON.stringify(repos)) setShared("gh-board.repos", repos);
          const pick = shared("gh-board.selected");
          if (Array.isArray(pick)) {
            const names = repos.map((entry) => entry.repo);
            const kept = pick.filter((repo) => names.includes(repo));
            if (kept.length !== pick.length) setShared("gh-board.selected", kept.length === names.length ? null : kept);
          }
        }
        const every = this.repos.map((entry) => entry.repo);
        const pick = shared("gh-board.selected");
        const repos = Array.isArray(pick) ? every.filter((repo) => pick.includes(repo)) : every;
        if (!repos.length) {
          this.items = []; this.failed = 0; this.loadedAt = Date.now();
          this.error = every.length ? "No repos picked" : null;
          return;
        }

        const batches = [];
        for (let i = 0; i < repos.length; i += BATCH) batches.push(repos.slice(i, i + BATCH));
        const results = await Promise.all(batches.map(async (slice) => {
          try { return { slice, data: await fetchBatch(slice) }; }
          catch (e) { return { slice, error: String(e?.message || e) }; }
        }));

        const items = [];
        const failed = [];
        let firstError = null;
        for (const result of results) {
          if (result.error) { failed.push(...result.slice); firstError = firstError || result.error; continue; }
          result.slice.forEach((repo, index) => {
            const node = result.data[`r${index}`];
            if (!node) { failed.push(repo); return; }
            for (const issue of node.issues?.nodes ?? []) items.push(toItem(repo, "issue", issue));
            for (const pr of node.pullRequests?.nodes ?? []) items.push(toItem(repo, "pr", pr));
          });
        }
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.items = items;
        this.failed = failed.length;
        this.loadedAt = Date.now();
        this.error = items.length || !failed.length ? null : (firstError || `${failed.length} repos failed`);
        for (const item of items.slice(0, 6)) this.loadDetail(item, cx);
      } catch (e) {
        this.error = String(e?.message || e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Full details for one item, once: hovering a row starts it, and the card
  // fills in when it lands (a cx.notify reaches inside an open HoverCard).
  loadDetail(item, cx) {
    const known = this.details[item.key];
    if (known && known.updatedAt === item.updatedAt) return;
    if (this.loadingDetail[item.key]) return;
    this.loadingDetail[item.key] = true;
    cx.spawn(async (cx) => {
      try {
        const args = [item.kind === "pr" ? "pr" : "issue", "view", String(item.number), "-R", item.repo, "--json", item.kind === "pr" ? PR_JSON : ISSUE_JSON];
        const r = await exec("gh", args);
        if (r.code !== 0) throw new Error((r.stderr || "gh failed").trim().split("\n").pop());
        this.details[item.key] = { ...JSON.parse(r.stdout), updatedAt: item.updatedAt };
      } catch (e) {
        this.details[item.key] = { error: String(e?.message || e), updatedAt: item.updatedAt };
      } finally {
        this.loadingDetail[item.key] = false;
        cx.notify();
      }
    });
  }

  // The branch button: name the worktree, the branch and the agent.
  // Everything about an item's worktree that needs no call into the app.
  paths(item) {
    const entry = (this.repos ?? []).find((repo) => repo.repo === item.repo);
    const folder = entry?.dir ?? `${this.root()}/${item.repo.split("/")[1]}`;
    const label = `#${item.number} ${item.title}`;
    const repoName = slug(folder.split("/").filter(Boolean).pop() || item.repo.split("/")[1]);
    return { folder, label, tab: label.slice(0, 64), path: `${home()}/.herdr/worktrees/${repoName}/${issueName(item.number, label)}` };
  }

  // One spaces() per render (see render); the folder set is built there.
  ready(item) {
    return Boolean(this.openFolders?.has(this.paths(item).path));
  }

  target(item) {
    const paths = this.paths(item);
    return { ...paths, space: spaces().find((space) => space.folder === paths.path) ?? null };
  }

  openNew(item) {
    const { folder, label, tab } = this.target(item);
    openOverlay({
      mod: "gh-new", kind: "dialog", width: 560,
      props: { repo: item.repo, folder, number: item.number, label, tab },
    });
  }

  // Its worktree is already there: go to it, and to the tab this item opened.
  openExisting(item) {
    const { space, tab } = this.target(item);
    if (!space) return false;
    run("space.select", { id: space.id });
    const found = (space.tabs ?? []).find((each) => each.name === tab);
    if (found) run("tab.select", { id: found.id });
    return true;
  }

  // The pointer resting on a row builds its card; leaving it (and not entering the
  // card) takes it away again, after a moment, so the two are one surface.
  hoverRow(item, on, cx) {
    const key = item.key;
    if (on) {
      this.hoverHold = false;
      if (this.hoverKey !== key) {
        this.hoverKey = key;
        this.loadDetail(item, cx);
        cx.notify();
      }
      return;
    }
    cx.timer.after(220, (cx) => {
      if (this.hoverKey === key && !this.hoverHold) { this.hoverKey = null; cx.notify(); }
    });
  }

  // Clicking a row shows its box at the bottom of the column; clicking it again hides it.
  selectRow(item, cx) {
    this.selected = this.selected === item.key ? null : item.key;
    if (this.selected) this.loadDetail(item, cx);
    cx.notify();
  }

  setFilter(value, cx) {
    if (this.filter === value) return;
    this.filter = value;
    store("gh-board.filter", value);
    cx.notify();
  }

  toggleChanges(cx) {
    this.hideChanges = !this.hideChanges;
    store("gh-board.hideChanges", this.hideChanges ? "1" : "");
    cx.notify();
  }

  chip(label, value, count, t, cx) {
    const active = this.filter === value;
    return div().id(`gh-filter-${value}`).h(22).px(9).flex().items_center().gap(5).rounded(6).text_size(11).cursor_pointer()
      .bg(active ? t.selected : t.raised)
      .text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.setFilter(value, cx); })
      .child(label)
      .child(div().text_size(10).text_color(active ? t.muted : t.dim).child(String(count)));
  }

  // A filter that says why the list is short, and can be taken off again.
  changesChip(count, t, cx) {
    const active = this.hideChanges;
    return div().id("gh-hide-changes").h(22).px(9).flex().items_center().gap(5).rounded(6).text_size(11).cursor_pointer()
      .bg(active ? t.ansi1 + "22" : t.raised).text_color(active ? t.ansi1 : t.muted)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggleChanges(cx); })
      .child(div().min_w(0).truncate().child("Changes requested"))
      .child(div().flex_none().text_size(10).text_color(active ? t.ansi1 : t.dim).child(String(count)))
      .when(active, (e) => e.child(div().flex_none().text_size(9.5).text_color(t.ansi1).child("✕")));
  }

  pill(item, t) {
    const pr = item.kind === "pr";
    const tone = pr ? (item.draft ? t.dim : t.ansi5) : t.ansi2;
    return div().w(pr ? 22 : 40).flex_none().h(16).flex().items_center().justify_center().rounded(4)
      .bg(tone + "22").text_color(tone).text_size(9.5).child(pr ? "PR" : "Issue");
  }

  tags(item, t, limit, withLabels) {
    const out = [];
    if (item.draft) out.push({ text: "draft", tone: t.dim });
    if (item.review === "APPROVED") out.push({ text: "approved", tone: t.ansi2 });
    if (item.review === "CHANGES_REQUESTED") out.push({ text: "changes requested", tone: t.ansi1 });
    if (withLabels) for (const label of item.labels) out.push({ text: label, tone: t.dim });
    return out.slice(0, limit).map((tag) =>
      div().h(16).px(5).flex().items_center().rounded(4).bg(tag.tone + "22").text_color(tag.tone).text_size(9.5).child(tag.text));
  }

  branchButton(item, t, cx) {
    const exists = this.ready(item);
    return div().id(`gh-branch-${item.key}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(exists ? t.accent : t.dim).cursor_pointer().hover((s) => s.bg(t.selected).text_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!this.openExisting(item)) this.openNew(item); })
      .child(svg("mods/gh-board/branch.svg").size(12));
  }

  // A small button in a card: no awaits, so a click always shows something at once.
  cardButton(id, label, primary, onClick, t, disabled = false) {
    return div().id(id).h(24).px(10).flex().items_center().gap(5).rounded(6).text_size(11)
      .bg(primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.muted)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }))
      .child(label);
  }

  card(item, t, docked = false) {
    const d = this.details[item.key];
    const at = docked ? "gh-dock" : "gh-card";
    const pr = item.kind === "pr";
    const tone = pr ? (item.draft ? t.dim : t.ansi5) : t.ansi2;
    const head = h_flex().gap(6).items_center()
      .child(this.pill(item, t))
      .child(div().text_size(11).text_color(t.dim).child(`#${item.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(item.repo))
      .when(Boolean(d?.state), (e) => e.child(div().text_size(10).text_color(d.state === "OPEN" ? t.ansi2 : d.state === "MERGED" ? t.ansi5 : t.dim).child(String(d.state).toLowerCase())))
      .when(docked, (e) => e.child(div().id(`${at}-close-${item.key}`).px(4).text_size(11).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.selected = null; cx.notify(); }).child("✕")));

    const shell = docked
      ? v_flex().w_full().flex_none().h(300).p(11).gap(6).bg(t.background).border_t(1).border_color(t.border)
      : v_flex().w(440).max_w(440).p(11).gap(7).rounded(10).bg(t.popover).border_1().border_color(t.border).shadow_lg();

    // The row's buttons, here too: the dialog opens at once, no host call first.
    const existing = this.ready(item);
    const footer = h_flex().gap(6).items_center().pt(3).border_t(1).border_color(t.border)
      .child(this.cardButton(`${at}-open-${item.key}`, "Open worktree", Boolean(existing), () => this.openExisting(item), t, !existing))
      .child(this.cardButton(`${at}-new-${item.key}`, "New worktree", !existing, () => this.openNew(item), t))
      .child(div().flex_1())
      .child(div().id(`${at}-gh-${item.key}`).h(24).px(7).flex().items_center().rounded(6).text_size(11)
        .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openUrl(item.url); }).child("GitHub ↗"))
;

    if (!d || d.error) {
      return shell.child(head)
        .child(div().text_size(13).font_semibold().child(item.title))
        .child(div().text_size(11).text_color(d?.error ? t.ansi1 : t.dim).child(d?.error ?? "Loading…"))
        .child(footer);
    }

    const meta = [];
    if (d.author?.login) meta.push(`by ${d.author.login}`);
    if (d.createdAt) meta.push(`opened ${day(d.createdAt)}`);
    if (d.updatedAt) meta.push(`updated ${relative(d.updatedAt)}`);
    const stats = [];
    if (pr) {
      if (Number.isFinite(d.additions)) stats.push(`+${d.additions}`);
      if (Number.isFinite(d.deletions)) stats.push(`−${d.deletions}`);
      if (Number.isFinite(d.changedFiles)) stats.push(`${d.changedFiles} files`);
      if (d.headRefName) stats.push(`${d.headRefName} → ${d.baseRefName}`);
      if (d.reviewDecision) stats.push(d.reviewDecision.toLowerCase().replace(/_/g, " "));
      if (d.isDraft) stats.push("draft");
    } else {
      if (d.milestone?.title) stats.push(`milestone ${d.milestone.title}`);
      if (d.assignees?.length) stats.push(`assigned ${d.assignees.map((a) => a.login).join(", ")}`);
    }
    const body = (d.body ?? "").trim();
    const tags = this.tags(item, t, 6, true);
    // An estimate is enough: markdown wraps at the card's width, so count the
    // wrapped lines and give the description its own fixed box when it is long.
    const lines = body.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 62)), 0);
    const boxed = body.length > 0 && lines > 12;

    return shell
      .child(head)
      .child(div().text_size(13).font_semibold().child(d.title || item.title))
      .child(div().text_size(10.5).text_color(t.dim).child(meta.join(" · ")))
      .when(tags.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().children(tags)))
      .when(stats.length > 0, (e) => e.child(div().text_size(10.5).text_color(tone).child(stats.join(" · "))))
      .child(body.length > 0
        ? div().when(docked, (e) => e.flex_1().min_h(0))
          .when(!docked && boxed, (e) => e.flex_none().h(Math.min(320, Math.max(96, lines * 16 + 14))))
          .when(!docked && !boxed, (e) => e.flex_none())
          .overflow_y_scrollbar()
          .child(TextView.markdown(`${at}-body-${item.key}`, body).text_size(11.5).text_color(t.muted))
        : div().text_size(11).text_color(t.dim).child("No description."))
      .child(footer);
  }

  row(item, t, wide, cx) {
    const pill = this.pill(item, t);
    const time = div().text_size(10.5).text_color(t.dim).child(relative(item.updatedAt));
    const hover = (s) => s.bg(t.hover);
    const open = () => this.selectRow(item, cx);
    const tags = this.tags(item, t, wide ? 3 : 2, wide);
    // Narrow (the side panel): the title gets its own line under the facts.
    const body = wide
      ? h_flex().id(`gh-${item.key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(this.selected === item.key, (e) => e.bg(t.selected)).hover(hover).on_click(open)
        .child(pill)
        .child(div().w(120).flex_none().min_w(0).truncate().text_size(11).text_color(t.muted).child(item.repo.split("/")[1]))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${item.number}`))
        .child(div().flex_1().min_w(0).truncate().child(item.title).when(item.draft, (e) => e.text_color(t.muted)))
        .when(tags.length > 0, (e) => e.child(h_flex().flex_none().gap(4).children(tags)))
        .child(div().w(84).flex_none().truncate().text_size(10.5).text_color(t.dim).child(item.author))
        .child(time)
        .child(this.branchButton(item, t, cx))
      : v_flex().id(`gh-${item.key}`).flex_none().px(8).py(4).gap(2).rounded(6).cursor_pointer()
        .when(this.selected === item.key, (e) => e.bg(t.selected)).hover(hover).on_click(open)
        .child(h_flex().gap(6).items_center().child(pill)
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(item.repo.split("/")[1]))
          .when(tags.length > 0, (e) => e.child(h_flex().flex_none().gap(4).children(tags)))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`#${item.number}`))
          .child(time)
          .child(this.branchButton(item, t, cx)))
        .child(div().min_w(0).truncate().child(item.title).when(item.draft, (e) => e.text_color(t.muted)));

    // Hovering a row fetches its details; the card is anchored in its own layer,
    // and only the row under the pointer builds one.
    const shown = this.hoverKey === item.key;
    return Popup.new(`gh-card-${item.key}`, body.on_hover((on, cx) => this.hoverRow(item, on, cx)))
      .anchor("right_center")
      .when(shown, (e) => e.content(this.card(item, t).on_hover((on, cx) => {
        this.hoverHold = on;
        if (!on) this.hoverRow(item, false, cx);
      })));
  }

  render(cx) {
    const t = theme();
    const wide = this.width >= 620;
    // Another copy (the repo picker) changed the selection: ask again.
    const pickKey = JSON.stringify(shared("gh-board.selected") ?? null);
    if (pickKey !== this.selectedKey) {
      this.selectedKey = pickKey;
      this.refresh(cx);
    }
    const rootKey = `${shared("gh-board.root") ?? ""}|${shared("gh-board.rescan") ?? 0}`;
    if (rootKey !== this.rootKey) {
      this.rootKey = rootKey;
      this.refresh(cx, true);
    }

    this.openFolders = new Set(spaces().map((space) => space.folder ?? ""));
    const changes = this.items.filter(isChanges).length;
    const showChanges = changes > 0 || this.hideChanges;
    const visible = this.hideChanges ? this.items.filter((item) => !isChanges(item)) : this.items;
    const issues = visible.filter((item) => item.kind === "issue").length;
    const prs = visible.length - issues;
    // Do the four chips fit on one line? Fall back to a second one when they do not.
    const zoom = Number(settings().zoom) || 1;
    const design = chipWidth("All", visible.length) + chipWidth("Issues", issues) + chipWidth("PRs", prs) +
      chipWidth("Changes requested", changes, 18) + 18; // 18: the gaps between four chips
    const together = (design + 20) * zoom + 12 <= this.width; // 20: the bar's px, 12: slack
    const shown = visible.filter((item) => this.filter === "all" || item.kind === this.filter).slice(0, MAX_ROWS);
    const ago = this.loadedAt ? relative(new Date(this.loadedAt).toISOString()) : null;
    const picked = this.repos ? this.repos.filter((entry) => {
      const pick = shared("gh-board.selected");
      return !Array.isArray(pick) || pick.includes(entry.repo);
    }).length : 0;

    return v_flex().id("gh-board-root").size_full().min_h(0).rounded(10).overflow_hidden().text_size(12.5)
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground)
      .on_size_change((size, cx) => {
        const width = size.width;
        if (Math.abs(width - this.width) > 24) { this.width = width; cx.notify(); }
      })
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Issues & PRs"))
        .child(div().flex_1())
        .child(div().id("gh-repos").h(20).px(8).flex().items_center().gap(5).rounded(6).text_size(11).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => openOverlay({ mod: "gh-repos", kind: "dialog", width: 480, frame: "none" }))
          .child("Repos")
          .child(div().text_size(10).text_color(t.dim).child(this.repos ? `${picked}/${this.repos.length}` : "")))
        .child(div().id("gh-new-tree").h(20).px(8).flex().items_center().gap(5).rounded(6).text_size(11).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => openOverlay({ mod: "gh-new", kind: "dialog", width: 560, props: { mode: "repo" } }))
          .child("New"))
        .child(div().id("gh-refresh").h(20).px(8).flex().items_center().gap(5).rounded(6).text_size(11)
          .text_color(this.loading ? t.dim : t.muted).hover((s) => s.bg(t.hover)).cursor_pointer()
          .on_click((_e, cx) => this.refresh(cx, true))
          .child(this.loading
            ? div().frames(["◐", "◓", "◑", "◒"], 200).child("◐")
            : div().child("Refresh"))))
      // The list filters are tabs; "changes requested" narrows the same list on top
      // of them, so it sits apart, on the right — on the same line when it fits.
      .child(v_flex().flex_none().px(10).py(5).gap(4).border_b(1).border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(this.chip("All", "all", visible.length, t, cx))
          .child(this.chip("Issues", "issue", issues, t, cx))
          .child(this.chip("PRs", "pr", prs, t, cx))
          .when(showChanges && together, (e) => e.child(div().flex_1()).child(this.changesChip(changes, t, cx))))
        .when(showChanges && !together, (e) => e.child(h_flex().gap(6).items_center().child(div().flex_1()).child(this.changesChip(changes, t, cx)))))
      .child(div().id(`gh-list-${this.filter}-${this.hideChanges ? "c" : "n"}`).flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(!shown.length, (e) => e.child(v_flex().size_full().items_center().justify_center().gap(4).p(16)
          .child(div().text_color(t.muted).child(this.error ? "Could not read issues" : this.loading ? "Loading…" : "Nothing open"))
          .child(div().text_size(11).text_color(t.dim).child(this.error || (this.loading ? "" : "No open issues or pull requests")))))
        .children(shown.map((item) => this.row(item, t, wide, cx))))
      .when(Boolean(visible.find((item) => item.key === this.selected)), (e) => e.child(this.card(visible.find((item) => item.key === this.selected), t, true)))
      .when(shown.length > 0 || this.failed > 0 || Boolean(this.error), (e) => e.child(h_flex().flex_none().h(24).px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error || `${shown.length} of ${visible.length} shown${visible.length > MAX_ROWS ? ` (first ${MAX_ROWS})` : ""}`))
        .when(this.failed > 0, (s) => s.child(div().text_color(t.ansi3).child(`${this.failed} failed`)))
        .child(div().child(!ago ? "" : ago === "now" ? "just now" : `updated ${ago} ago`))));
  }
}
