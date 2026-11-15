import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Popup, InputState, Input } from "gpui-base";
import { exec, focused, home, theme, openOverlay, panes, run, spaces, shared, setShared, settings } from "herdr";
import * as fs from "fs/promises";
import { cleanBody, COMMENT_BODY, CARD_BODY } from "./body.js";
import { tint, initials, text, relativeIso, slug, nwo, issueName } from "./format.js";

// The Issues section of the git panel: open issues and PRs of the GitHub repos under
// ~/repo (a picked subset of them), from `gh api graphql`: one batched query per 20 repos.
// Hover a row for its details; its branch button opens the worktree + agent dialog.
// Not a View of its own: gh-git owns the copy and its timer, and calls body(cx).
// GitHub's graph costs a point per 100 objects in every connection it returns, and the
// host ticks every 15s for the git views: the batch gets its own, slower clock.
const REFRESH_MS = 120000;
const RESERVE = 200; // points left untouched, so opening a card or a comment still fits
const BATCH = 20;
const MAX_ROWS = 300;
const PR_JSON = "number,title,state,isDraft,author,body,createdAt,updatedAt,labels,reviewDecision,additions,deletions,changedFiles,headRefName,baseRefName,url,mergeable,reviews";
const ISSUE_JSON = "number,title,state,author,body,createdAt,updatedAt,labels,url,assignees,milestone";
// The conversation shown in full; the rest is counted, never silently dropped.
const MAX_COMMENTS = 8;
// How long a failed detail stays on its card before it is asked for again: GitHub refusing one
// request says nothing about the PR, and the reason (a limit) goes away by itself.
const DETAIL_RETRY_MS = 20000;
// A comment thread is written by anyone: only its first page is read, so a 5000-comment
// thread costs one request and 10 bodies, not the whole conversation in memory.
const COMMENT_PAGE = 10;
// The branch read behind a changes-requested PR is one request each, and the batch can hold a
// thousand rows: ask about the ones at the top of the list, never the whole set.
const REVIEW_READS = 20;

// The colour that says what an item is before a word is read: an open issue its own, a PR
// another, a draft muted, a merged PR violet, a closed one red.
function toneOf(item, detail, t) {
  const state = String(detail?.state ?? "OPEN").toUpperCase();
  if (state === "MERGED") return t.ansi5;
  if (state === "CLOSED") return t.ansi1;
  return item.kind === "pr" ? (item.draft ? t.dim : t.ansi5) : t.ansi2;
}

// GitHub keeps `reviewDecision: CHANGES_REQUESTED` until someone submits a new review, so a
// branch that moved after the request still carries the flag. Compare the newest commit the
// author wrote with the last changes-requested review: a newer one means the author answered
// (hence "needs a re-review"), one that is not newer means the work is still to be done.
// The query asks for the newest such review alone, so it is the first node.
const lastChangesRequestedAt = (node) => Date.parse(node.reviews?.nodes?.[0]?.submittedAt ?? "") || 0;

// Whether the author answered: the newest commit that isn't a merge from the base branch, which
// moves the head past the review without answering anything. GraphQL can only say that with a
// connection inside every commit, and that shape was 12 points for one repo against 2 (GitHub
// refused the 24-repo batch outright), so the branch is read over REST instead: one request per
// head commit seen, kept by sha. The head's own date is the answer when it can't be asked.
const COMMITS = new Map(); // sha -> the newest non-merge commit's time
async function answeredAt(item) {
  const sha = item.head;
  if (!sha) return item.committedAt;
  const known = COMMITS.get(sha);
  if (known !== undefined) return known;
  let answered = item.committedAt;
  let settled = false;
  try {
    const r = await exec("gh", ["api", `repos/${item.repo}/commits?sha=${sha}&per_page=20`, "--jq", ".[] | [.commit.committer.date, (.parents | length)] | @tsv"]);
    if (r.code === 0) {
      settled = true;
      const own = r.stdout.split("\n").map((line) => line.split("\t"))
        .filter(([, parents]) => Number(parents) <= 1)
        .map(([at]) => Date.parse(at) || 0)
        .filter(Boolean);
      if (own.length) answered = Math.max(...own);
    }
  } catch { /* the head's own date answers it until the request can be made */ }
  // Only an answer is kept: a failed request must not freeze the chip until the head moves.
  if (settled) {
    if (COMMITS.size > 500) COMMITS.clear();
    COMMITS.set(sha, answered);
  }
  return answered;
}
const addressed = (item) => item.kind === "pr" && item.review === "CHANGES_REQUESTED" && item.answeredAt > item.reviewedAt;
const isChanges = (item) => item.kind === "pr" && item.review === "CHANGES_REQUESTED" && !addressed(item);

// The orders the list can be put in. Kept in shared state, like the filters.
const SORTS = ["updated", "created", "number", "repo"];

function day(iso) {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 10) : "";
}

// An issue body may be written by anyone: what of it reaches the renderer is decided in
// ./body.js — its images gone, its tags attribute-less, and a bound on what is parsed.

// A choice made before the filters moved into shared state; read once, never written.
function stored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

async function scanRepos(root) {
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return null; }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
  const found = new Array(dirs.length).fill(null);
  let next = 0;
  // Six at a time: a folder with thousands of subdirectories must not spawn them all.
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= dirs.length) return;
      const dir = `${root}/${dirs[index]}`;
      try {
        if (!(await fs.exists(`${dir}/.git`))) continue; // not a checkout (a worktree has a .git file)
        const r = await exec("git", ["-C", dir, "config", "--get", "remote.origin.url"]);
        const repo = r.code === 0 ? nwo(r.stdout.trim()) : null;
        if (repo) found[index] = { dir, repo };
      } catch { /* not a checkout */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, dirs.length) }, worker));
  const seen = new Set();
  return found.filter((entry) => entry && !seen.has(entry.repo) && (seen.add(entry.repo), true));
}

const FIELDS = `
  nameWithOwner
  issues(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url updatedAt author { login } comments { totalCount } labels(first: 4) { nodes { name } } }
  }
  pullRequests(first: 50, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
    nodes { number title url updatedAt isDraft reviewDecision author { login } comments { totalCount } labels(first: 4) { nodes { name } }
      reviews(last: 1, states: [CHANGES_REQUESTED]) { nodes { submittedAt } }
      commits(last: 1) { nodes { commit { oid committedDate } } } }
  }`;

function batchQuery(repos) {
  const aliases = repos.map((repo, i) => {
    const [owner, name] = repo.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${FIELDS} }`;
  });
  return `query { rateLimit { cost remaining resetAt } ${aliases.join(" ")} }`;
}

// What the last answer said about this hour's points. Shared by every copy on purpose: one
// panel running dry is the token's, so the others stop with it instead of asking again.
const RATE = { remaining: null, resetAt: 0 };
// A refusal with points still left is GitHub throttling a burst, not the hour: back off a
// little instead of waiting for a reset that would waste the points that remain.
// Each refusal in a row doubles the wait (3, 6, 12, then half an hour): a token GitHub is
// already cross with is not helped by asking again every three minutes.
const PARK = { until: 0, strikes: 0 };

async function fetchBatch(repos) {
  const r = await exec("gh", ["api", "graphql", "-f", `query=${batchQuery(repos)}`]);
  let body;
  try { body = JSON.parse(r.stdout); } catch {
    const line = (r.stderr || r.stdout || "gh failed").trim().split("\n").filter(Boolean);
    throw new Error(line[line.length - 1] || "gh failed");
  }
  if (!body || !body.data) throw new Error(body?.errors?.[0]?.message || "gh returned no data");
  const rate = body.data.rateLimit;
  if (rate) {
    RATE.remaining = Number(rate.remaining);
    RATE.resetAt = Date.parse(rate.resetAt) || 0;
    PARK.until = 0; // an answer got through: the last refusal is over
    PARK.strikes = 0;
  }
  // A partial answer keeps what came back, but its errors are the caller's to say: a repo that
  // came back null because of one is not silently absent from the list.
  return { data: body.data, errors: (body.errors ?? []).map((error) => String(error?.message ?? error)) };
}

// How long to leave GitHub alone: a refusal just made, or points too few to spend.
function rateWait() {
  if (PARK.until > Date.now()) return PARK.until - Date.now();
  const left = RATE.remaining;
  if (left === null || left > RESERVE) return 0;
  return RATE.resetAt > Date.now() ? RATE.resetAt - Date.now() : 0;
}

function toItem(repo, kind, node) {
  return {
    repo, kind,
    key: `${repo}#${node.number}${kind === "pr" ? "p" : ""}`,
    number: Number(node.number),
    title: text(node.title),
    url: node.url,
    updatedAt: node.updatedAt || "",
    author: text(node.author?.login || "ghost"),
    comments: node.comments?.totalCount ?? 0,
    labels: (node.labels?.nodes ?? []).map((label) => text(label.name)),
    draft: Boolean(node.isDraft),
    review: node.reviewDecision || null,
    reviewedAt: lastChangesRequestedAt(node),
    head: node.commits?.nodes?.[0]?.commit?.oid ?? "",
    committedAt: Date.parse(node.commits?.nodes?.[0]?.commit?.committedDate ?? "") || 0,
    answeredAt: 0, // filled in by refresh, once a changes-requested PR needs it
  };
}

// Rough chip widths (the ui font is monospace): enough to know whether the four
// fit on one line, with a wrap as the fallback — never an overlap.
const textWidth = (text, size) => String(text).length * size * 0.56;
const chipWidth = (label, count, extra = 0) =>
  18 + textWidth(label, 11) + (count == null ? 0 : 6 + textWidth(count, 10)) + extra;

const BUILT_IN_TAGS = new Set(["draft", "approved", "changes requested"]);

// Only GitHub over https, and only through the host's guarded opener.
function openGitHub(url, cx) {
  if (!/^https:\/\/([a-z0-9-]+\.)?github\.com\//i.test(String(url ?? ""))) return;
  cx.open_url(url);
}

// The center's context, as { folder, tab, cwd }: the number comes from the tab ("#28 ...") or
// the worktree branch ("28-..."); the repo from the checkout containing the folder, else the
// worktree's repo dir name. An issue and its fix PR share the number, so an open PR wins.
// Anything less than a scoped match is null: never a same-number item from another repo.
function followTarget(follow, repos, items) {
  if (!follow || typeof follow !== "object") return null;
  const folder = [follow.folder, follow.cwd].find((p) => typeof p === "string" && p);
  const tab = typeof follow.tab === "string" ? follow.tab : "";
  const tabNum = (tab.match(/^#(\d+)\b/) || [])[1];
  const wt = folder && /[\\/]\.herdr[\\/]worktrees[\\/]/.test(folder)
    ? folder.split(/[\\/]/).filter(Boolean).slice(-2)
    : null;
  const wtNum = wt && (wt[1].match(/^(\d+)-/) || [])[1];
  const n = tabNum || wtNum;
  if (!n) return null;
  let repoNames = [];
  if (folder) {
    repoNames = repos.filter((e) => folder === e.dir || folder.startsWith(`${e.dir}/`)).map((e) => e.repo);
    if (!repoNames.length && wt) {
      const want = wt[0].toLowerCase();
      repoNames = repos
        .filter((e) => slug(e.dir.split("/").filter(Boolean).pop() || "").toLowerCase() === want)
        .map((e) => e.repo);
    }
  }
  const pool = items.filter((i) => i.number === Number(n));
  if (!pool.length) return null;
  if (!repoNames.length) {
    // A number with no repo signal: match only when unambiguous (one repo owns it).
    if (new Set(pool.map((i) => i.repo)).size !== 1) return null;
    return pool.find((i) => i.kind === "pr") ?? pool[0];
  }
  const scoped = pool.filter((i) => repoNames.includes(i.repo));
  if (!scoped.length) return null;
  return scoped.find((i) => i.kind === "pr") ?? scoped[0];
}

// The focused center as a follow-shaped {folder, tab, cwd}: the active space's
// folder, its active tab's name, the focused pane's cwd.
function activeFollow() {
  const space = spaces().find((s) => s.active);
  const tab = space?.tabs?.find((t) => t.active);
  const cwd = focused()?.cwd ?? panes().find((p) => p.focused)?.cwd ?? null;
  return { folder: space?.folder ?? null, tab: tab?.name ?? null, cwd };
}

export default class Issues {
  // The gh-git copy that shows this section owns the timers and the size; the state lives here.
  constructor(host) {
    this.host = host;
    this.props = host.props ?? {};
    this.repos = null;
    this.items = [];
    this.details = {};
    this.loadingDetail = {};
    this.epochs = {}; // "<card|dock>|<key>" -> how many times that card has opened
    this.loading = false;
    this.error = null;
    this.failed = 0;
    this.loadedAt = null;
    this.parked = false; // the rate-choice was shown for the current wait
    this.pending = undefined; // a refresh asked for while one was in flight
    this.waitUntil = 0; // set when GitHub's hourly points run out: no request before then
    // The filters belong to the person, not to the focused center: kept in shared state,
    // so another layout, a re-opened panel or a restart finds them as they were left.
    const filter = shared("gh-board.filter") ?? stored("gh-board.filter");
    const changes = shared("gh-board.hideChanges") ?? (stored("gh-board.hideChanges") === "1");
    this.filter = ["issue", "pr"].includes(filter) ? filter : "all";
    this.hideChanges = changes === true;
    const sort = shared("gh-board.sort");
    this.sort = SORTS.includes(sort) ? sort : "updated";
    this.menu = ""; // "" | "sort": whether the order choices are open
    this.query = ""; // the text filter, this copy's own
    this.input = InputState.new({ placeholder: "filter by title, label, repo, number" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.selected = null;
    this.contextKey = null; // last focused center seen by applyActive
    this.hoverKey = null;
    this.hoverHold = false;
    this.selectedKey = JSON.stringify(shared("gh-board.selected") ?? null);
    this.rootKey = `${shared("repos.root") ?? ""}|${shared("gh-board.rescan") ?? 0}`;
  }

  // Started the first time the section is shown: a panel left on Trees or Commits asks GitHub
  // nothing. The host's own 15 s tick calls refresh(cx); the 120 s batch clock guards the calls.
  start(cx) {
    this.refresh(cx, true);
  }

  // gh-git's panel size; the list and the cards wrap at this width.
  get width() { return this.host.width; }

  // The folder repos live in: Settings' (mods/settings), then one a host gives, then ~/repo.
  // Both are read as untrusted: a planted value must not climb anywhere, whichever way it came.
  root() {
    const plain = (value) => {
      const path = String(value ?? "").trim().replace(/^~(?=$|\/)/, home()).replace(/\/+$/, "");
      return path !== "/" && path.startsWith("/") && !path.split("/").some((part) => part === "." || part === "..") ? path : "";
    };
    return plain(shared("repos.root")) || plain(this.props && this.props.root) || `${home()}/repo`;
  }

  refresh(cx, rescan = false) {
    // The panel is not on screen (another stack child, a hidden column): ask GitHub nothing.
    // A rescan is the person pressing the button, which can only happen while it shows.
    if (!rescan && this.host && !this.host.shown()) return;
    if (this.loading) { this.pending = Boolean(this.pending) || rescan; return; }
    // The host ticks every 15s for the git views; the batch has its own, slower clock, and a
    // spent hour or a refusal means no request at all. A rescan is a person asking, so it gets
    // its try (and is parked again at once if GitHub still says no).
    if (!rescan && this.loadedAt && Date.now() - this.loadedAt < REFRESH_MS) return;
    const wait = rescan ? 0 : rateWait();
    if (wait > 0) {
      this.waitUntil = Date.now() + wait;
      this.error = this.rateText();
      if (!this.parked) { this.parked = true; cx.notify(); }
      return;
    }
    this.parked = false;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        if (!this.repos || rescan) {
          const repos = await scanRepos(this.root());
          if (repos === null) throw new Error(`No folder at ${this.root()}`);
          this.repos = repos;
          this.pathCache?.clear();
          // The repo picker and the from-scratch dialog read the list from here.
          if (JSON.stringify(shared("gh-board.repos") ?? null) !== JSON.stringify(repos)) setShared("gh-board.repos", repos);
          const pick = shared("gh-board.selected");
          if (Array.isArray(pick) && pick.length) {
            const names = repos.map((entry) => entry.repo);
            const kept = pick.filter((repo) => names.includes(repo));
            // Everything picked vanished (another folder): show everything rather than
            // an empty panel. An explicit "None" ([]) is left alone.
            if (kept.length !== pick.length) setShared("gh-board.selected", kept.length === 0 || kept.length === names.length ? null : kept);
          }
        }
        const every = this.repos.map((entry) => entry.repo);
        const pick = shared("gh-board.selected");
        const repos = Array.isArray(pick) ? every.filter((repo) => pick.includes(repo)) : every;
        if (!repos.length) {
          this.items = []; this.failed = 0; this.loadedAt = Date.now();
          this.pathCache?.clear();
          this.error = every.length ? "No repos picked" : null;
          return;
        }

        // One batch after the other: GitHub throttles bursts (and reports it as a rate limit),
        // so a second of patience is cheaper than a refusal that costs the whole refresh.
        const results = [];
        for (let i = 0; i < repos.length; i += BATCH) {
          const slice = repos.slice(i, i + BATCH);
          try { results.push({ slice, ...(await fetchBatch(slice)) }); }
          catch (e) { results.push({ slice, error: String(e?.message || e) }); }
        }

        const items = [];
        const failed = [];
        let firstError = null;
        for (const result of results) {
          if (result.error) { failed.push(...result.slice); firstError = firstError || result.error; continue; }
          if (result.errors?.length) firstError = firstError || result.errors[0];
          result.slice.forEach((repo, index) => {
            const node = result.data[`r${index}`];
            if (!node) { failed.push(repo); return; }
            for (const issue of node.issues?.nodes ?? []) items.push(toItem(repo, "issue", issue));
            for (const pr of node.pullRequests?.nodes ?? []) items.push(toItem(repo, "pr", pr));
          });
        }
        // Only the PRs whose review still stands need the branch read, and only once per head:
        // every other item is answered by the batch alone. Bounded, and left alone the moment
        // the hour runs short: a repo set with many changes-requested PRs must not spend the
        // rest of the budget on its own before the list is drawn.
        const asking = items.filter((entry) => entry.kind === "pr" && entry.review === "CHANGES_REQUESTED");
        for (const item of asking.slice(0, REVIEW_READS)) {
          if (rateWait() > 0) break;
          item.answeredAt = await answeredAt(item);
        }
        items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        this.items = items;
        // The derived paths (label, tab, worktree folder) are per item list: a retitled item
        // must not keep the name its old title made.
        this.pathCache?.clear();
        this.failed = failed.length;
        this.loadedAt = Date.now();
        const limited = results.some((result) => result.error && /rate limit/i.test(result.error));
        if (limited) await this.parkRateLimit();
        // Said even when the rest came back: half a list that doesn't say so reads as the truth.
        this.error = limited ? this.rateText() : failed.length ? `${failed.length} repos failed${firstError ? `: ${firstError}` : ""}` : null;
        for (const item of items.slice(0, 6)) this.loadDetail(item, cx);
      } catch (e) {
        this.error = String(e?.message || e);
      } finally {
        this.loading = false;
        cx.notify();
        if (this.pending !== undefined) {
          const rescanNow = Boolean(this.pending);
          this.pending = undefined;
          this.refresh(cx, rescanNow);
        }
      }
    });
  }

  // GitHub's own reset time, asked of an endpoint that still answers, so the panel waits
  // exactly as long as it must and says so instead of echoing a raw error.
  async parkRateLimit() {
    let [left, reset] = [RATE.remaining, RATE.resetAt];
    try {
      // The endpoint that still answers while the graph endpoint refuses.
      const r = await exec("gh", ["api", "rate_limit", "--jq", "[.resources.graphql.remaining, .resources.graphql.reset] | @tsv"]);
      if (r.code === 0) {
        const [remaining, at] = String(r.stdout).trim().split("\t").map(Number);
        if (Number.isFinite(remaining)) left = remaining;
        if (Number.isFinite(at)) reset = at * 1000;
      }
    } catch { /* an estimate beats asking again */ }
    const spent = left === null || left <= RESERVE;
    RATE.remaining = left;
    RATE.resetAt = reset;
    // Spent: the hour's reset. Points left: a burst was refused, so wait and try again, doubling.
    PARK.strikes += 1;
    const wait = spent && reset > Date.now()
      ? reset - Date.now()
      : Math.min(30 * 60000, 3 * 60000 * 2 ** (PARK.strikes - 1));
    PARK.until = Date.now() + wait;
    this.waitUntil = PARK.until;
  }

  rateText() {
    const minutes = Math.max(1, Math.round(((this.waitUntil || PARK.until) - Date.now()) / 60000));
    return RATE.remaining !== null && RATE.remaining <= RESERVE
      ? `GitHub's hourly points are used up: asking again in ${minutes}m.`
      : `GitHub is throttling requests: asking again in ${minutes}m.`;
  }

  // Full details for one item, once: hovering a row starts it, and the card
  // fills in when it lands (a cx.notify reaches inside an open HoverCard).
  loadDetail(item, cx) {
    const known = this.details[item.key];
    const retry = known?.error && Date.now() - (known.at ?? 0) > DETAIL_RETRY_MS;
    if (known && known.updatedAt === item.updatedAt && !retry) return;
    if (this.loadingDetail[item.key]) return;
    this.loadingDetail[item.key] = true;
    cx.spawn(async (cx) => {
      try {
        const args = [item.kind === "pr" ? "pr" : "issue", "view", String(item.number), "-R", item.repo, "--json", item.kind === "pr" ? PR_JSON : ISSUE_JSON];
        const r = await exec("gh", args);
        if (r.code !== 0) throw new Error((r.stderr || "gh failed").trim().split("\n").pop());
        this.details[item.key] = this.cleanDetail(JSON.parse(r.stdout), item, await this.comments(item));
        this.trimDetails();
      } catch (e) {
        this.details[item.key] = { error: String(e?.message || e), updatedAt: item.updatedAt, at: Date.now() };
        this.trimDetails();
      } finally {
        this.loadingDetail[item.key] = false;
        cx.notify();
      }
    });
  }

  // The first page of a thread, in the shape `gh view` used to give: a hostile thread costs
  // one request, not the whole conversation read into memory before it is cut down.
  async comments(item) {
    const r = await exec("gh", ["api", `repos/${item.repo}/issues/${item.number}/comments?per_page=${COMMENT_PAGE}`]).catch(() => null);
    if (!r || r.code !== 0) return null;
    try {
      const page = JSON.parse(r.stdout);
      return Array.isArray(page) ? page.map((c) => ({
        author: { login: c.user?.login ?? "" },
        authorAssociation: c.author_association ?? "",
        body: c.body ?? "",
        createdAt: c.created_at ?? "",
      })) : [];
    } catch { return []; }
  }

  // Every string the card prints goes through text() here: an issue title, a head ref, a
  // milestone or a login can carry the bidi overrides a list row is already protected from.
  cleanDetail(raw, item, comments) {
    return {
      ...raw,
      title: text(raw.title),
      headRefName: text(raw.headRefName ?? ""),
      baseRefName: text(raw.baseRefName ?? ""),
      milestone: raw.milestone ? { ...raw.milestone, title: text(raw.milestone.title) } : raw.milestone,
      assignees: (raw.assignees ?? []).map((a) => ({ ...a, login: text(a.login) })),
      comments: (comments ?? raw.comments ?? []).map((entry) => ({
        ...entry,
        clean: cleanBody(String(entry?.body ?? ""), COMMENT_BODY),
      })),
      reviews: (raw.reviews ?? []).map((review) => ({
        ...review,
        author: { login: text(review.author?.login ?? "") },
        state: review.state ?? "COMMENTED",
        submittedAt: review.submittedAt ?? "",
        clean: cleanBody(String(review.body ?? ""), COMMENT_BODY),
      })),
      cleanBody: cleanBody(raw.body ?? "", CARD_BODY),
      updatedAt: item.updatedAt,
    };
  }

  // Hovering many rows must not grow for the whole session: the card cache keeps the last 60.
  trimDetails() {
    const keys = Object.keys(this.details);
    if (keys.length <= 60) return;
    for (const key of keys.slice(0, keys.length - 60)) delete this.details[key];
  }

  // An overflow area keeps its scroll filed under the id it was built with. Every open gets a
  // new one, so a card starts at the top instead of inheriting the previous wheel gesture; the
  // id stays put while it is open, so scrolling and later re-renders leave the position alone.
  cardBodyId(at, item) {
    return `${at}-scroll-${item.key}-${this.epochs[`${at}|${item.key}`] ?? 0}`;
  }

  openCard(at, item) {
    const key = `${at}|${item.key}`;
    this.epochs[key] = (this.epochs[key] ?? 0) + 1;
  }

  // The branch button: name the worktree, the branch and the agent.
  // Everything about an item's worktree that needs no call into the app.
  paths(item) {
    this.pathCache ??= new Map();
    const cached = this.pathCache.get(item.key);
    if (cached) return cached;
    const entry = (this.repos ?? []).find((repo) => repo.repo === item.repo);
    const folder = entry?.dir ?? `${this.root()}/${item.repo.split("/")[1]}`;
    const label = `#${item.number} ${item.title}`;
    const repoName = slug(folder.split("/").filter(Boolean).pop() || item.repo.split("/")[1]) || "repo";
    const out = { folder, label, tab: label.slice(0, 64), path: `${home()}/.herdr/worktrees/${repoName}/${issueName(item.number, label)}` };
    this.pathCache.set(item.key, out);
    return out;
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
      props: { repo: item.repo, folder, number: item.number, label, tab, pr: item.kind === "pr" ? item.number : null },
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
        this.openCard("gh-card", item);
        this.loadDetail(item, cx);
        cx.notify();
      }
      return;
    }
    cx.timer.after(220, (cx) => {
      if (this.hoverKey === key && !this.hoverHold) { this.hoverKey = null; cx.notify(); }
    });
  }

  // Clicking a row docks its card AND jumps to the agent working on it (the
  // branch button's openExisting): the whole row goes to the tab, not just
  // the icon. No worktree yet: just dock/undock the card as before.
  selectRow(item, cx) {
    this.selected = this.selected === item.key ? null : item.key;
    if (this.selected) {
      this.openCard("gh-dock", item);
      this.loadDetail(item, cx);
      this.openExisting(item);
    }
    cx.notify();
  }

  // Whether the list's filters keep this item out of view. Following the center never
  // changes them: what is hidden is said above the list, and shown on a click.
  hidden(item) {
    return (this.filter !== "all" && this.filter !== item.kind) || (this.hideChanges && isChanges(item)) || !this.matches(item);
  }

  // Show an item the filters keep out, on an explicit click: the one path that widens them.
  showItem(item, cx) {
    if (this.filter !== "all" && this.filter !== item.kind) this.setFilter(item.kind, cx);
    if (this.hideChanges && isChanges(item)) this.toggleChanges(cx);
    if (!this.matches(item)) { this.input.set_value(""); this.query = ""; cx.notify(); }
  }

  // The center moved without an agent click (tab bar, space list, row jump):
  // select what it works on, or clear a selection it no longer works on. A
  // manual row click survives until the center moves again.
  applyActive(cx) {
    if (!this.repos) return;
    const follow = activeFollow();
    const key = JSON.stringify(follow);
    if (key === this.contextKey) return;
    if (!this.items.length) return; // list still loading: retry later
    this.contextKey = key;
    const target = followTarget(follow, this.repos, this.items);
    if (!target) {
      this.selected = null;
      return;
    }
    if (this.selected === target.key) return;
    this.selected = target.key;
    this.openCard("gh-dock", target);
    this.loadDetail(target, cx);
  }

  // The same items in another order: nothing is re-fetched, the list is only read differently.
  ordered(list) {
    const out = [...list];
    if (this.sort === "created") out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else if (this.sort === "number") out.sort((a, b) => b.number - a.number || a.repo.localeCompare(b.repo));
    else if (this.sort === "repo") out.sort((a, b) => a.repo.localeCompare(b.repo) || b.number - a.number);
    else out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return out;
  }

  // Whether the text filter keeps this item: its number, title, labels or repo.
  matches(item) {
    const needle = String(this.query ?? "").trim().toLowerCase();
    if (!needle) return true;
    return `${item.repo} #${item.number} ${item.title} ${item.labels.join(" ")}`.toLowerCase().includes(needle);
  }

  // An empty list says what emptied it, and offers the way out.
  emptyState(t, querying) {
    return v_flex().size_full().items_center().justify_center().gap(4).p(16)
      .child(div().text_color(t.muted)
        .child(this.waitUntil > Date.now() ? "Waiting for GitHub" : this.error ? "Could not read issues" : this.loading ? "Loading…" : querying ? "Nothing matches" : "Nothing open"))
      .child(div().text_size(12).text_color(t.muted)
        .child(this.error || (this.loading ? "" : querying ? "No title, label or repo matches the filter" : "No open issues or pull requests")))
      .when(querying, (x) => x.child(div().id("gh-clear").text_size(12).text_color(t.accent).cursor_pointer()
        .on_click((_e, cx) => { this.input.set_value(""); this.query = ""; cx.notify(); })
        .child("Clear the filter")));
  }

  setSort(value, cx) {
    this.sort = value;
    this.menu = "";
    setShared("gh-board.sort", value);
    cx.notify();
  }

  setFilter(value, cx) {
    if (this.filter === value) return;
    this.filter = value;
    setShared("gh-board.filter", value);
    cx.notify();
  }

  toggleChanges(cx) {
    this.hideChanges = !this.hideChanges;
    setShared("gh-board.hideChanges", this.hideChanges);
    cx.notify();
  }

  chip(label, value, count, t, cx) {
    const active = this.filter === value;
    return div().id(`gh-filter-${value}`).h(22).px(9).flex().items_center().gap(5).rounded(6).text_size(12).cursor_pointer()
      .bg(active ? t.selected : t.raised)
      .text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(active ? t.selected : t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.setFilter(value, cx); })
      .child(label)
      .child(div().text_size(11).text_color(active ? t.foreground : t.muted).child(String(count)));
  }

  // A filter that says why the list is short, and can be taken off again.
  changesChip(count, rereview, t, cx) {
    const active = this.hideChanges;
    return div().id("gh-hide-changes").h(22).px(9).flex().items_center().gap(5).rounded(6).text_size(12).cursor_pointer()
      .bg(active ? t.ansi1 + "22" : t.raised).text_color(active ? t.ansi1 : t.muted)
      .tooltip(rereview > 0
        ? `${count} still waiting for changes, ${rereview} pushed since the review (shown as re-review)`
        : `${count} still waiting for changes`)
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.toggleChanges(cx); })
      .child(div().min_w(0).truncate().child("Changes requested"))
      .child(div().flex_none().text_size(11).text_color(active ? t.ansi1 : t.muted).child(String(count)))
      .when(active, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child("✕")));
  }

  // A pill in the card's own family: a tint, a border and the words.
  pill(item, t) {
    const tone = toneOf(item, null, t);
    return h_flex().h(18).px(6).flex_none().items_center().rounded(5)
      .bg(tint(tone, "1c")).border_1().border_color(tint(tone, "4d"))
      .child(div().text_size(11).font_medium().text_color(tone).child(item.kind === "pr" ? "PR" : "Issue"));
  }

  statePill(state, t) {
    const up = String(state).toUpperCase();
    const tone = up === "MERGED" ? t.ansi5 : up === "CLOSED" ? t.ansi1 : t.ansi2;
    return h_flex().h(17).px(5).flex_none().items_center().rounded(5)
      .bg(tint(tone, "1c")).border_1().border_color(tint(tone, "4d"))
      .child(div().text_size(10.5).font_medium().text_color(tone).child(up.toLowerCase()));
  }

  tags(item, t, limit, withLabels) {
    const out = [];
    if (item.draft) out.push({ text: "draft", tone: t.dim });
    if (item.review === "APPROVED") out.push({ text: "approved", tone: t.ansi2 });
    if (item.review === "CHANGES_REQUESTED") {
      // Commits after the last changes-requested review: the author answered, and GitHub keeps
      // the request until a reviewer looks again. Said as its own state, not as more red.
      out.push(addressed(item)
        ? { text: "re-review", tone: t.ansi3, tip: "commits landed after the changes-requested review; GitHub keeps the flag until a reviewer looks again" }
        : { text: "changes requested", tone: t.ansi1, tip: "the requested changes are still to be made" });
    }
    if (withLabels) {
      for (const label of item.labels) {
        if (BUILT_IN_TAGS.has(label.toLowerCase())) continue;
        out.push({ text: label, tone: t.dim });
      }
    }
    return out.slice(0, limit).map((tag) =>
      h_flex().h(17).px(5).flex_none().items_center().rounded(4)
        .bg(tint(tag.tone, "17")).border_1().border_color(tint(tag.tone, "3d"))
        .when(Boolean(tag.tip), (e) => e.tooltip(tag.tip))
        .child(div().text_size(11).text_color(tag.tone).child(tag.text)));
  }

  // Who wrote it: initials on a tint, so a name reads at a glance and the line stays short.
  avatar(login, t, size = 20) {
    const palette = [t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi2];
    let hash = 0;
    for (const ch of String(login)) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
    const color = palette[hash % palette.length];
    return div().size(size).flex_none().rounded_full().flex().items_center().justify_center()
      .bg(tint(color, "26")).border_1().border_color(tint(color, "66")).tooltip(`Written by ${login}`)
      // A line box the height of the glyph is what centers capitals: the default leading
      // sits the baseline low, and two initials keep the same box as one.
      .child(div().text_size(size * 0.44).line_height(1).text_center().font_semibold().text_color(color).child(initials(login)));
  }

  // How many comments an item has, in the list: the one number that says whether opening it
  // is a conversation or a one-way note.
  commentChip(item, t) {
    return h_flex().h(17).px(5).gap(3).flex_none().items_center().rounded(4).bg(t.raised)
      .tooltip(`${item.comments} comment${item.comments === 1 ? "" : "s"}`)
      .child(svg("mods/gh-git/comment.svg").size(11).flex_none().text_color(t.dim))
      .child(div().text_size(11).text_color(t.muted).child(String(item.comments)));
  }

  // A part of the card: a small label, a count and a hairline, so the text reads in sections.
  section(label, count, t) {
    return h_flex().gap(6).items_center().pt(4)
      .child(div().flex_none().text_size(10.5).font_semibold().text_color(t.muted).child(label.toUpperCase()))
      .when(count != null, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.muted).child(String(count))))
      .child(div().flex_1().h(1).bg(t.border));
  }

  // The numbers a PR is read for, and what an issue is filed under: coloured facts in a row.
  facts(item, detail, t) {
    const out = [];
    if (item.kind === "pr") {
      if (Number.isFinite(detail.additions)) out.push({ text: `+${detail.additions}`, tone: t.ansi2 });
      if (Number.isFinite(detail.deletions)) out.push({ text: `−${detail.deletions}`, tone: t.ansi1 });
      if (Number.isFinite(detail.changedFiles)) out.push({ text: `${detail.changedFiles} files`, tone: t.muted });
      if (detail.headRefName) out.push({ text: `${detail.headRefName} → ${detail.baseRefName}`, tone: t.ansi4 });

    } else {
      if (detail.milestone?.title) out.push({ text: `milestone ${detail.milestone.title}`, tone: t.ansi6 });
      if (detail.assignees?.length) out.push({ text: `assigned ${detail.assignees.map((a) => a.login).join(", ")}`, tone: t.ansi4 });
    }
    if (!out.length) return null;
    return h_flex().gap(5).flex_wrap().children(out.map((fact) =>
      h_flex().h(17).px(5).flex_none().items_center().rounded(5)
        .bg(tint(fact.tone, "17")).border_1().border_color(tint(fact.tone, "3d"))
        .child(div().text_size(10.5).text_color(fact.tone).child(fact.text))));
  }

  // One comment: the avatar hangs on the thread's line, the words in a card of their own, so a
  // conversation reads as a conversation and not as one long block of text.
  comment(entry, index, count, t, id) {
    const body = entry.clean ?? "";
    const login = text(entry.author?.login || "ghost");
    const last = index >= count - 1;
    const association = text(entry.association || "");
    const state = String(entry.state ?? "").toUpperCase();
    const stateText = state === "CHANGES_REQUESTED" ? "changes requested" : state.toLowerCase();
    const stateTone = state === "APPROVED" ? t.ansi2 : state === "CHANGES_REQUESTED" ? t.ansi1 : t.dim;
    return h_flex().gap(8).items_start().flex_none()
      .child(v_flex().w(20).flex_none().items_center()
        .child(this.avatar(login, t, 20))
        .when(!last, (e) => e.child(div().w(2).flex_1().min_h(8).bg(t.border))))
      .child(v_flex().flex_1().min_w(0).pb(6).gap(3)
        .child(h_flex().gap(6).items_center().min_w(0)
          .child(div().flex_none().text_size(12.5).font_semibold().text_color(t.foreground).child(login))
          .when(Boolean(association) && association !== "NONE", (e) => e.child(h_flex().h(15).px(4).flex_none()
            .items_center().rounded(4).bg(tint(t.accent, "22"))
            .child(div().text_size(10.5).text_color(t.accent).child(association.toLowerCase()))))
          .when(Boolean(state), (e) => e.child(h_flex().h(15).px(4).flex_none().items_center().rounded(4)
            .bg(tint(stateTone, "1c")).border_1().border_color(tint(stateTone, "4d"))
            .tooltip(`Review: ${stateText}`)
            .child(div().text_size(10.5).text_color(stateTone).child(stateText))))
          .child(div().flex_1())
          .child(div().flex_none().text_size(10.5).text_color(t.muted).child(relativeIso(entry.at))))
        .child(div().flex_none().rounded(8).bg(t.raised).border_1().border_color(t.border).px(9).py(7)
          .when(Boolean(body), (e) => e.child(TextView.markdown(id, body).selectable(true).text_size(12.5)
            .text_color(t.muted).on_link_click((url, cx) => openGitHub(url, cx))))
          .when(!body, (e) => e.child(div().text_size(12).text_color(t.muted).child("(no text)")))));
  }

  // Comments and review bodies are one conversation: GitHub's issue-comment endpoint carries
  // only the replies, so a review (approval, changes requested, dismissed) would be invisible.
  conversation(detail) {
    const comments = (detail?.comments ?? [])
      .filter((entry) => entry && String(entry.clean ?? "").trim())
      .map((entry) => ({ at: entry.createdAt, author: entry.author, body: entry.body, clean: entry.clean, association: entry.authorAssociation, state: "" }));
    const reviews = (detail?.reviews ?? [])
      .filter((entry) => entry && (String(entry.clean ?? "").trim() || String(entry.state ?? "") !== "COMMENTED"))
      .map((entry) => ({ at: entry.submittedAt, author: entry.author, body: entry.body, clean: entry.clean, state: entry.state }));
    return {
      comments,
      reviews,
      all: [...comments, ...reviews].sort((a, b) => (Date.parse(a.at || "") || 0) - (Date.parse(b.at || "") || 0)),
    };
  }

  commentThread(detail, item, t, at) {
    const { comments, all } = this.conversation(detail);
    const list = all.slice(0, MAX_COMMENTS);
    // The list carries the comment total; only the first page was read, so the count of what
    // is not shown comes from there and stays right for a thread of any size. Reviews are all
    // here already.
    const shownComments = list.filter((entry) => !entry.state).length;
    const more = Math.max(Number(item.comments ?? 0), comments.length) - shownComments;
    return v_flex().gap(0).flex_none()
      .children(list.map((entry, index) => this.comment(entry, index, list.length, t, `${at}-c-${item.key}-${index}`)))
      .when(more > 0, (e) => e.child(h_flex().gap(6).items_center().pt(2)
        .child(div().w(20).flex_none())
        .child(div().text_size(11).text_color(t.muted)
          .child(`${more} more comment${more === 1 ? "" : "s"} on GitHub`))));
  }

  branchButton(item, t, cx) {
    const exists = this.ready(item);
    return div().id(`gh-branch-${item.key}`).w(18).h(18).flex_none().flex().items_center().justify_center().rounded(4)
      .text_color(exists ? t.accent : t.dim).cursor_pointer().hover((s) => s.bg(t.selected).text_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); if (!this.openExisting(item)) this.openNew(item); })
      .child(svg("mods/gh-git/branch.svg").size(12));
  }

  // A small button in a card: no awaits, so a click always shows something at once.
  cardButton(id, label, primary, onClick, t, disabled = false) {
    return div().id(id).h(24).px(10).flex().items_center().gap(5).rounded(6).text_size(12)
      .bg(primary ? t.solid : t.raised).text_color(disabled ? t.dim : primary ? t.solid_foreground : t.muted)
      .when(!disabled, (e) => e.cursor_pointer().hover((s) => s.bg(primary ? t.solid : t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); onClick(); }))
      .child(label);
  }

  // The detail sheet: what it is across the top in its own colour, the words in sections, and
  // the conversation below them. Docked at the bottom of the panel, or floating over a row.
  // The dock takes what a card needs without eating the list: a share of the panel, bounded.
  dockHeight() {
    return Math.round(Math.max(300, Math.min(620, (this.host.height || 900) * 0.42)));
  }

  // A floating card is sized by its words until they no longer fit the window; past that its
  // height is definite, because only a definite height gives the body a scroll viewport (a
  // max-height only clips it under the window's edge).
  floatingHeight(detail) {
    if (!detail) return null;
    const words = String(detail.body ?? "").length +
      (detail.comments ?? []).reduce((n, entry) => n + String(entry?.body ?? "").length, 0);
    if (words <= 1000) return null;
    return Math.round(Math.max(320, Math.min(620, (this.host.height || 900) - 130)));
  }

  card(item, t, docked = false) {
    const detail = this.details[item.key];
    const at = docked ? "gh-dock" : "gh-card";
    const height = docked ? this.dockHeight() : this.floatingHeight(detail);
    const tone = toneOf(item, detail, t);
    const shell = docked
      ? v_flex().w_full().flex_none().min_w(0).h(height).overflow_hidden()
        .bg(t.background).border_t(1).border_color(t.border)
      : v_flex().w(540).max_w(540).max_h(620).rounded(12).overflow_hidden()
        .bg(t.popover).border_1().border_color(t.border).shadow_lg()
        .when(Boolean(height), (e) => e.h(height));
    const band = div().w_full().flex_none().h(3).bg(tone);
    const head = h_flex().gap(7).items_center().px(12).pt(9)
      .child(this.pill(item, t))
      .child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child(`#${item.number}`))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(item.repo))
      .when(Boolean(detail?.state), (e) => e.child(this.statePill(detail.state, t)))
      .when(docked, (e) => e.child(div().id(`${at}-close-${item.key}`).w(18).h(18).flex().items_center().justify_center()
        .rounded(5).text_size(12).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.selected = null; cx.notify(); })
        .child(svg("mods/pane/close.svg").size(11))));
    const title = div().px(12).pt(5).min_w(0).text_size(docked ? 13.5 : 15).font_semibold()
      .text_color(t.foreground).child(detail?.title || item.title);

    // The row's buttons, here too: the dialog opens at once, no host call first.
    const existing = this.ready(item);
    const footer = h_flex().gap(6).items_center().px(12).pt(8).pb(10).border_t(1).border_color(t.border)
      .child(this.cardButton(`${at}-open-${item.key}`, "Open worktree", Boolean(existing), () => this.openExisting(item), t, !existing))
      .child(this.cardButton(`${at}-new-${item.key}`, "New worktree", !existing, () => this.openNew(item), t))
      .child(div().flex_1())
      .child(div().id(`${at}-gh-${item.key}`).h(24).px(7).flex().items_center().rounded(6).text_size(12)
        .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); openGitHub(item.url, cx); }).child("GitHub ↗"));

    if (!detail || detail.error) {
      return shell.child(band).child(head).child(title)
        .child(div().px(12).pt(8).flex_1().text_size(12).text_color(detail?.error ? t.ansi1 : t.muted)
          .child(detail?.error ?? "Opening…"))
        .child(footer);
    }

    // The whole body: the card scrolls, so nothing of the issue is cut mid-sentence. (Comment
    // entries keep their own cap: a thread of eight is bounded without hiding the issue.)
    const body = detail.cleanBody;
    const conversation = this.conversation(detail);
    const count = Math.max(Number(item.comments ?? 0), conversation.comments.length) + conversation.reviews.length;
    const facts = this.facts(item, detail, t);
    const labels = this.tags(item, t, 8, true);
    const login = text(detail.author?.login || "ghost");
    const when = [detail.createdAt ? `opened ${day(detail.createdAt)}` : null,
      detail.updatedAt ? `updated ${relativeIso(detail.updatedAt)}` : null].filter(Boolean).join(" · ");

    // Docked, the card has a set height and the body takes what is left of it; floating, the
    // card is as tall as its words, up to a bound, so the body sets the height instead of
    // collapsing to nothing inside a column that has none.
    const content = v_flex().id(this.cardBodyId(at, item)).min_w(0).px(12).pb(4).gap(6).overflow_y_scrollbar()
      .when(docked || Boolean(height), (e) => e.flex_1().min_h(0))
      .when(!docked && !height, (e) => e.flex_none().max_h(440))
      .child(h_flex().gap(6).items_center().min_w(0)
        .child(this.avatar(login, t, 18))
        .child(div().flex_none().text_size(11.5).text_color(t.muted).child(login))
        .child(div().flex_none().text_size(10.5).text_color(t.muted).child(when)))
      .when(Boolean(facts), (e) => e.child(facts))
      .when(labels.length > 0, (e) => e.child(h_flex().gap(4).flex_wrap().children(labels)))
      .child(this.section("description", null, t))
      .when(Boolean(body), (e) => e.child(div().flex_none().min_w(0)
        .child(TextView.markdown(`${at}-body-${item.key}`, body).selectable(true)
          .text_size(docked ? 12 : 12.5).text_color(t.muted).on_link_click((url, cx) => openGitHub(url, cx)))))
      .when(!body, (e) => e.child(div().text_size(12.5).text_color(t.muted).child("No description.")))
      .when(count > 0, (e) => e.child(this.section("conversation", count, t)).child(this.commentThread(detail, item, t, at)));

    return shell.child(band).child(head).child(title).child(content).child(footer);
  }

  row(item, t, wide, cx) {
    const pill = this.pill(item, t);
    const time = div().text_size(12.5).text_color(t.muted).child(relativeIso(item.updatedAt));
    const hover = (s) => s.bg(t.hover);
    const open = () => this.selectRow(item, cx);
    const tags = this.tags(item, t, wide ? 3 : 2, wide);
    // Narrow (the side panel): the title gets its own line under the facts.
    const body = wide
      ? h_flex().id(`gh-${item.key}`).h(30).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(this.selected === item.key, (e) => e.bg(t.selected)).hover(hover).on_click(open)
        .child(pill)
        .child(div().w(120).flex_none().min_w(0).truncate().text_size(12).text_color(t.muted).child(item.repo.split("/")[1]))
        .child(div().flex_none().text_size(12).text_color(t.muted).child(`#${item.number}`))
        .child(div().flex_1().min_w(0).truncate().child(item.title).when(item.draft, (e) => e.text_color(t.muted)))
        .when(tags.length > 0, (e) => e.child(h_flex().flex_none().gap(4).children(tags)))
        .when(item.comments > 0, (e) => e.child(this.commentChip(item, t)))
        .child(div().w(84).flex_none().truncate().text_size(11.5).text_color(t.muted).child(item.author))
        .child(time)
        .child(this.branchButton(item, t, cx))
      // Narrow (the side panel): one line per fact, so nothing competes for the width:
      // what it is, what it says, then who wrote it and where it stands.
      : v_flex().id(`gh-${item.key}`).flex_none().px(8).py(6).gap(3).rounded(6).cursor_pointer()
        .when(this.selected === item.key, (e) => e.bg(t.selected)).hover(hover).on_click(open)
        .child(h_flex().gap(6).items_center()
          .child(pill)
          .child(div().flex_none().text_size(12.5).text_color(t.muted).child(`#${item.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(item.repo.split("/")[1]))
          .child(time))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(14).font_medium().child(item.title)
            .when(item.draft, (e) => e.text_color(t.muted)))
          .when(item.comments > 0, (e) => e.child(this.commentChip(item, t))))
        .child(h_flex().gap(5).items_center()
          .child(h_flex().flex_1().min_w(0).gap(5).items_center()
            .child(this.avatar(item.author, t, 18))
            .child(div().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(item.author)))
          .when(tags.length > 0, (e) => e.child(h_flex().flex_none().gap(4).children(tags)))
          .child(this.branchButton(item, t, cx)));

    // Hovering a row fetches its details; the card is anchored in its own layer, and only
    // the row under the pointer builds both the popup and the card in it.
    const hovered = body.on_hover((on, cx) => this.hoverRow(item, on, cx));
    if (this.hoverKey !== item.key) return hovered;
    return Popup.new(`gh-card-${item.key}`, hovered)
      .anchor("right_center")
      .content(this.card(item, t).on_hover((on, cx) => {
        this.hoverHold = on;
        if (!on) this.hoverRow(item, false, cx);
      }));
  }

  body(cx) {
    const t = theme();
    const wide = this.width >= 620;
    // Another copy (the repo picker) changed the selection: ask again. One read, used below.
    const pick = shared("gh-board.selected");
    const pickKey = JSON.stringify(pick ?? null);
    if (pickKey !== this.selectedKey) {
      this.selectedKey = pickKey;
      this.refresh(cx);
    }
    const rootKey = `${shared("repos.root") ?? ""}|${shared("gh-board.rescan") ?? 0}`;
    if (rootKey !== this.rootKey) {
      this.rootKey = rootKey;
      this.pathCache?.clear();
      this.refresh(cx, true);
    }
    this.applyActive(cx);

    this.openFolders = new Set(spaces().map((space) => space.folder ?? ""));
    const changes = this.items.filter(isChanges).length;
    const rereview = this.items.filter(addressed).length;
    const showChanges = changes > 0 || rereview > 0 || this.hideChanges;
    const visible = this.hideChanges ? this.items.filter((item) => !isChanges(item)) : this.items;
    const issues = visible.filter((item) => item.kind === "issue").length;
    const prs = visible.length - issues;
    // Do the four chips fit on one line? Fall back to a second one when they do not.
    const zoom = Number(settings().zoom) || 1;
    const design = chipWidth("All", visible.length) + chipWidth("Issues", issues) + chipWidth("PRs", prs) +
      chipWidth("Changes requested", changes, 18) + 18; // 18: the gaps between four chips
    const together = (design + 20) * zoom + 12 <= this.width; // 20: the bar's px, 12: slack
    const matching = this.ordered(visible.filter((item) => this.filter === "all" || item.kind === this.filter).filter((item) => this.matches(item)));
    const shown = matching.slice(0, MAX_ROWS);
    const querying = String(this.query ?? "").trim() !== "";
    // The followed row, even when the person's filters hide it: said above the list, with
    // a way to show it, rather than those filters being changed for them.
    const selectedItem = this.items.find((item) => item.key === this.selected) ?? null;
    const hiddenItem = selectedItem && this.hidden(selectedItem) ? selectedItem : null;
    const ago = this.loadedAt ? relativeIso(new Date(this.loadedAt).toISOString()) : null;
    const picked = this.repos ? this.repos.filter((entry) => !Array.isArray(pick) || pick.includes(entry.repo)).length : 0;

    return v_flex().id("gh-issues").flex_1().min_h(0).text_size(13).text_color(t.foreground)
      .child(h_flex().h(30).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0))
        .child(div().id("gh-repos").h(20).px(8).flex().flex_none().whitespace_nowrap().items_center().gap(5).rounded(6).text_size(12).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => openOverlay({ mod: "gh-repos", kind: "dialog", width: 480 }))
          .child("Repos")
          .child(div().flex_none().whitespace_nowrap().text_size(11).text_color(t.muted).child(this.repos ? `${picked}/${this.repos.length}` : "")))
        .child(div().id("gh-new-tree").h(20).px(8).flex().flex_none().whitespace_nowrap().items_center().gap(5).rounded(6).text_size(12).cursor_pointer()
          .text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click(() => openOverlay({ mod: "gh-new", kind: "dialog", width: 560, props: { mode: "repo" } }))
          .child("New"))
        .child(div().id("gh-refresh").h(20).px(8).flex().flex_none().whitespace_nowrap().items_center().gap(5).rounded(6).text_size(12)
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
          .when(showChanges && together, (e) => e.child(div().flex_1()).child(this.changesChip(changes, rereview, t, cx))))
        .when(showChanges && !together, (e) => e.child(h_flex().gap(6).items_center().child(div().flex_1()).child(this.changesChip(changes, rereview, t, cx))))
        .child(h_flex().gap(5).items_center()
          .child(h_flex().flex_1().min_w(0).child(Input.new(this.input).h(21).px(6).rounded(6)
            .bg(t.surface).border_1().border_color(this.focused ? t.accent : t.border)
            .text_size(12).text_color(t.foreground)))
          .child(h_flex().id("gh-sort").h(20).px(6).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
            .bg(this.menu === "sort" ? t.selected : t.raised)
            .hover((s) => s.bg(t.hover))
            .tooltip("Order the list")
            .on_click((_e, cx) => { this.menu = this.menu === "sort" ? "" : "sort"; cx.notify(); })
            .child(div().text_size(11).text_color(t.muted).child("sort"))
            .child(div().text_size(11.5).text_color(this.menu === "sort" ? t.foreground : t.muted)
              .child(this.sort))
            .child(div().text_size(10).text_color(t.muted).child(this.menu === "sort" ? "▲" : "▼")))))
      .when(this.menu === "sort", (e) => e.child(h_flex().flex_none().px(10).py(3).gap(4).border_b(1).border_color(t.border)
        .children(SORTS.map((value) => div().id(`gh-sort-${value}`).h(20).px(7).flex().items_center().rounded(5)
          .text_size(11.5).cursor_pointer()
          .bg(value === this.sort ? t.selected : t.raised)
          .text_color(value === this.sort ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.setSort(value, cx))
          .child(value)))))
      .when(Boolean(hiddenItem), (e) => e.child(h_flex().id("gh-hidden").flex_none().h(24).px(10).gap(6).items_center()
        .border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
          .child(`${hiddenItem.kind === "pr" ? "PR" : "Issue"} #${hiddenItem.number} is hidden by these filters`))
        .child(div().id("gh-hidden-show").h(18).px(7).flex().items_center().rounded(5).text_size(11.5).cursor_pointer()
          .bg(t.raised).text_color(t.accent).hover((s) => s.bg(t.selected))
          .on_click((_e, cx) => this.showItem(hiddenItem, cx)).child("Show"))))
      .child(div().id(`gh-list-${this.filter}-${this.hideChanges ? "c" : "n"}`).flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
        .when(!shown.length, (e) => e.child(this.emptyState(t, querying)))
        .children(shown.flatMap((item, index) =>
          index === shown.length - 1
            ? [this.row(item, t, wide, cx)]
            : [this.row(item, t, wide, cx), div().h(1).mx(8).flex_none().bg(t.border)])))
      .when(Boolean(selectedItem), (e) => e.child(this.card(selectedItem, t, true)))
      .when(shown.length > 0 || this.failed > 0 || Boolean(this.error), (e) => e.child(h_flex().flex_none().h(24).px(10).gap(6).items_center().border_t(1).border_color(t.border).text_size(11.5).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.ansi1 : t.muted)
          .child(this.error || `${shown.length} of ${querying ? matching.length : visible.length} shown${visible.length > MAX_ROWS ? ` (first ${MAX_ROWS})` : ""}`))
        .when(this.failed > 0, (s) => s.child(div().text_color(t.ansi3).child(`${this.failed} failed`)))
        .child(div().child(!ago ? "" : ago === "now" ? "just now" : `updated ${ago} ago`))));
  }
}
