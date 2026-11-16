import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Popover, Popup } from "gpui-base";
import { spaces, agents, panes, theme, settings, run, exec, hc, home, shared, setShared, openOverlay, closeOverlay, nextCommand, notify, setAgentOrder, layout } from "herdr";
import { readable, threadPrompts } from "./last-prompt.js";
import { generateTitle } from "./titles.js";
import { threadKey } from "./title-text.js";
import { lastModel } from "./agent-model.js";
import { brandOf, inkOn, readOn, splitModel } from "./model-brand.js";
import * as fs from "fs/promises";

// The spaces panel as two lists: the repos, then the spaces that are no repo at all.
// A repo is one tree, three levels deep:
//   repo (a colored square with its initials)  →  Main | branch / worktree  →  agent
// Every level above the agent says how many agents sit under it and in what state, as colored
// chips; the branch level also says how far the work is from origin (commits ahead/behind, what
// is not committed) and from main. A repo's main checkout always has its "Main" row, whether or
// not a space is open on it, and the + on the repo's row makes a branch on a checkout of its own.
// The bot on a branch row opens the tab bar's + menu on that branch: the same panel, every
// agent in it, started in that branch's own space rather than in the shown one, and drawn as a
// comic balloon beside the icon it came out of.
// A branch that exists only here — on no GitHub remote of the repo — carries the GitHub mark
// too: one click puts that branch there, and the repo itself first when it is on no GitHub yet.
// A space whose own folder becomes a checkout — a `git init` or a clone in ~/spaces/<name> — is a
// repo here too, from the scan after it becomes one (and again if the checkout goes away).
// Clicking a repo folds it, a branch/worktree goes to that space, an agent to that agent. Icons
// and chips carry a tooltip with the full story. A space with no repo sits in the second list,
// under its own label: it is one row with its agents under it, never a borrow of the repo shape.
// The middle of the bot button in the window, for the callout to open at. The event's own
// bounds are the straight answer; without them, the window position moved by how far from the
// middle the pointer landed. `null` leaves the popup to Herdr, which puts it at the pointer.
const iconCentre = (e, size) => {
  const b = e?.bounds;
  const box = b?.size ?? b;
  const origin = b?.origin ?? b;
  if (box?.width && origin?.x != null) return { x: origin.x + box.width / 2, y: origin.y + box.height / 2 };
  const s = size ?? { width: 21, height: 18 };
  if (e?.position && e.local_position) {
    return {
      x: e.position.x - e.local_position.x + s.width / 2,
      y: e.position.y - e.local_position.y + s.height / 2,
    };
  }
  return null;
};

const URGENCY = ["blocked", "working", "done", "idle"];
// The colour a subagent's record state names. pi-subagents says "error" where a theme says
// blocked: a job that failed needs a person just as much as one that is waiting.
const stateInk = (state, t) => (state === "error" ? t.blocked : t[state] ?? t.muted);
// A subagent still working or waiting outranks the parent's own turn, which says idle the
// moment it hands the work over: this is the order those records are read in.
const STATE_RANK = { blocked: 0, working: 1, error: 2, done: 3, idle: 4 };
// The branch row whose menu is up, as `new-menu-pinned` left it: { space, overlay, at, closed }.
// A press on the same bot closes the menu; 800 ms after one closed, a press opens it again.
const BRANCH_MENU = "spaces-tree.branch-menu";
// The order the panel can be put in, and the agents it can narrow itself to. Kept in shared
// state, so the panel opens as it was left rather than as it was written.
const SORTS = [["default", "as found"], ["name", "by name"], ["status", "by status"], ["agents", "by agents"]];
const ONLY = [["all", "all"], ["blocked", "blocked"], ["working", "working"], ["done", "done"], ["idle", "idle"]];
// A program, an agent or a space can set its own name, and a name can carry bidi overrides:
// they never reach the screen, so a title cannot reorder the rows around it.
const plain = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");
// A branch a row can act on: git says "(detached)" where there is none, and that is no ref.
const branchName = (value) => {
  const text = plain(value);
  return text && !text.startsWith("(") ? text : "";
};
// A ref git will take as a push's argument: never a flag or a refspec of its own, and nothing
// git's own check-ref-format refuses (so a branch like "città" or "fix/login" still goes).
const pushable = (ref) => {
  const text = String(ref ?? "");
  return text.length > 0
    && !text.startsWith("-")
    && !/[\x00-\x20\x7f~^:?*\[\\]/.test(text)
    && !text.includes("..") && !text.includes("@{") && !text.includes("//")
    && !text.endsWith("/") && !text.endsWith(".")
    && !text.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"));
};
// What an agent is called on screen: its program, else what runs it, else its tab.
const nameOf = (agent) => plain(agent.program?.name || agent.app || agent.tab_name || "terminal");

// What an agent's terminal says it is doing, for an agent whose store this mod cannot read (or
// before its first title is written). OMP puts a short all-caps kicker before its own title
// ("TITLE: ..."); the row does not need it. Paths and bare program names are not titles.
const nativeTitle = (agent) => {
  let text = plain(agent.title).trim();
  // OMP prefixes its title with its own mark, then a status spinner; Codex marks its state in
  // brackets. Neither names the thread, and neither should reach the row.
  text = text.replace(/^\u03c0\s+/, "").replace(/^\[ [!.] \]\s*/, "");
  text = text.replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();
  text = text.replace(/^[A-Z0-9]{2,8}:\s*/, "");
  const bare = [agent.program?.name, agent.program?.key, agent.address, agent.title]
    .map((value) => plain(value).trim().toLowerCase());
  if (!text || bare.includes(text.toLowerCase()) || /^([~/]|[A-Za-z]:\\)/.test(text)) return "";
  return text;
};

// The wall's layout and the blocks it builds one per agent: `wall-term-<address>` (see
// mods/agent-wall). A row is marked only for one of these, and only while that layout shows.
const WALL_LAYOUT = "agent-wall";
const WALL_TILE = "wall-term-";
const SCAN_MS = 15000;
// An agent whose terminal carries no subagent records is asked rarely: the records appear when
// one starts, and the poll is cheap only while something can be there.
const SUBS_IDLE_MS = 30000;
// One record per space, written while it is open: the row a closed branch or space keeps.
const RECORDS = "spaces-tree.spaces";
// A removal asked for a space that is still open: the row goes when the space does, and a close
// the person never answers stops being asked for after this long.
const REMOVE = "spaces-tree.remove";
const REMOVE_WAIT_MS = 300000;
const SIGHT_MS = 2000;
const KEPT_MAX = 60;
// The thinking levels a footer can name, as the four dots a card fills: the word alone was
// too quiet to read, and the meter says where it sits in the scale at a glance.
const EFFORT_LEVEL = { none: 0, minimal: 1, low: 1, medium: 2, high: 3, xhigh: 4, max: 4 };
// The card's sheen, drawn over its whole box at this opacity (see mods/spaces-tree/sheen.svg).
const SHEEN_INK = 0.34;
// One pulse for a working agent: its own mark, the model it runs and the share of thinking it
// spends all breathe at this period, so the card reads as one thing breathing.
const PULSE_MS = 1300;
// What the card's wash comes to at its left edge, where the tail joins it: sheen.svg at the
// middle of the edge is about 0.36 of its strongest stop, so the tail is filled with the same
// light and the join cannot show. Change SHEEN_INK and this follows it.
const TAIL_INK = 0.365 * SHEEN_INK;
const MAIN_REFS = ["origin/main", "origin/master", "main", "master"];

const INITIALS = (name) => {
  const words = String(name ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
};

// A stable, pleasing color per repo: the theme's accents, picked by name.
function tintOf(name, t) {
  const palette = [t.ansi4, t.ansi5, t.ansi3, t.ansi6, t.ansi2, t.ansi1];
  let hash = 0;
  for (const ch of String(name)) hash = (hash * 31 + ch.codePointAt(0)) % 100000;
  return palette[hash % palette.length];
}

// #rrggbb + alpha, for tinted chip backgrounds; anything else is left as it is.
function alpha(color, a) {
  const c = String(color ?? "");
  return /^#[0-9a-f]{6}$/i.test(c) ? c + a : c;
}

// The same colour with its alpha replaced. The theme's derived colours already carry one
// (`border` is white at 9%), so `alpha` would hand them back unchanged.
function fade(color, a) {
  const c = String(color ?? "");
  return /^#[0-9a-f]{8}$/i.test(c) ? c.slice(0, 7) + a : alpha(c, a);
}

// The folder repos live in, as Settings (mods/settings) keeps it: ~ is the home folder.
// Pure given the shared value, so the string work is done once per change, not per call.
let ROOT_MEMO = { raw: undefined, path: "" };
function reposRoot() {
  const chosen = shared("repos.root");
  const raw = typeof chosen === "string" && chosen.trim() ? chosen.trim() : "";
  if (ROOT_MEMO.raw === raw && ROOT_MEMO.path) return ROOT_MEMO.path;
  const path = (raw || `${home()}/repo`)
    .replace(/^~(?=$|\/)/, home())
    .replace(/\/+$/, "");
  // Only a plain absolute path: a value planted in shared state must not climb anywhere.
  const safe = path === "/" || !path.startsWith("/") || path.split("/").some((part) => part === "." || part === "..")
    ? `${home()}/repo`
    : path;
  ROOT_MEMO = { raw, path: safe };
  return safe;
}

// Where a checkout with a branch of its own is made: the same place the worktree dialog puts
// them, so a main opened from its row sits beside its siblings.
const WORKTREES = () => `${home()}/.herdr/worktrees`;
// A branch's folder under it: main is "main", a branch with slashes has them as dashes.
const branchDir = (branch) => String(branch).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

// Where a space lives: its repo (a checkout under the repos folder, or a worktree under
// ~/.herdr/worktrees) and the branch or worktree name the branch level shows.
function place(space) {
  const folder = String(space.folder ?? "").replace(/\/+$/, "");
  const worktree = folder.match(/\/\.herdr\/worktrees\/([^/]+)\/(.+)$/);
  if (worktree) return { repo: worktree[1], branch: space.branch || worktree[2], worktree: true };
  const root = reposRoot();
  const checkout = folder.startsWith(`${root}/`) ? folder.slice(root.length + 1) : "";
  if (checkout && !checkout.includes("/")) return { repo: checkout, branch: space.branch || "", worktree: false };
  return { repo: "", branch: space.branch || "", worktree: false };
}

export default class SpacesTree extends View {
  init(_props, cx) {
    this.closed = new Set(); // folded repos and spaces, by key
    this.git = {}; // space id -> { ahead, behind, dirty, upstream, mainAhead, mainBehind, mainRef } | null
    this.ids = {}; // space id -> { id, name }: the repo it belongs to, as the last scan found it
    this.mains = {}; // "<machine>|<folder>" -> the folder of the checkout that folder belongs to
    this.wts = {}; // "<machine>|<repo folder>" -> { gen, list }: the repo's local checkouts, as of one scan
    this.wtGen = 0; // bumped per scan, so one scan lists each repo's worktrees once
    this.wtMenu = ""; // the group whose worktrees menu is open, by key
    this.scanning = false;
    this.scanAt = 0; // when the running scan started: one that outlived the poll is not running
    this.scanGen = 0; // bumped per scan start: a stale scan applies nothing
    this.redrawPending = false; // a notify is already coalesced, not one per agent
    this.orderKey = ""; // the address order last handed to setAgentOrder
    this.menu = ""; // "" | "sort" | "only": which of the two option rows is open
    this.pressedAt = 0; // when the branch row's bot went down, this copy's last press
    this.iconCentre = null; // that press's button middle, in window coordinates
    this.botSize = null; // the bot button's laid-out size, reported by on_size_change
    // No branch menu outlives a start or a layout switch — its popup went with them — so a
    // record saying one is up is stale, and must not eat the first press.
    if (shared(BRANCH_MENU)) setShared(BRANCH_MENU, null);
    this.prompts = {}; // agent address -> { prompt, at }: what that agent was last asked
    this.threads = {}; // agent address -> { session, prompts, recap }: the thread behind it
    this.asking = new Set(); // agent addresses whose store is being read now
    this.titleJobs = new Map(); // agent address -> { key, thread, at }: title work waiting
    this.titleBusy = null; // the agent address whose title is being written now
    this.titleFailed = {}; // agent address -> key: a prompt set no generator answered
    this.subs = {}; // agent address -> { list, at }: the subagent records its terminal carries
    this.askingSubs = new Set(); // agent addresses whose records are being read now
    this.card = ""; // the agent address whose card is open under the pointer, if any
    this.under = ""; // the row the pointer is on, as on_hover reports it (see hot/pointsAt)
    this.hoverRow = ""; // the agent row the pointer is on now
    this.holdCard = false; // the pointer is on the open card itself
    this.models = {}; // agent address -> { text, at }: the model its footer named
    this.query = ""; // the text filter, this copy's own
    this.input = InputState.new({ placeholder: "filter spaces" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.focused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.focused = false; cx.notify(); });
    this.scan(cx);
    this.asked = new Set(); // space ids a removed row already asked Herdr to close
    cx.timer.every(SCAN_MS, (cx) => this.scan(cx));
    this.sighting();
    cx.timer.every(SIGHT_MS, () => this.sighting());
    this.refreshPrompts(cx);
    this.refreshSubagents(cx);
    cx.timer.every(5000, (cx) => { this.refreshPrompts(cx); this.refreshSubagents(cx); });
    // The commit and merge windows ask for a scan the moment they finish, so the chips
    // change now instead of on the next poll. A scan notifies itself; nothing else is sent.
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "scan") this.scan(cx);
      }
    });
  }

  // One notify for a burst of changes (many agents' prompts landing at once): the next frame
  // is enough, and a render per agent is not.
  redraw(cx) {
    if (this.redrawPending) return;
    this.redrawPending = true;
    cx.timer.after(50, (cx) => { this.redrawPending = false; cx.notify(); });
  }

  // How far each space is from origin, from a clean tree and from main: a few `git` calls each,
  // published in shared state so the bottom bar can show the shown space's without asking again.
  scan(cx) {
    // A scan already running is not a reason to lose this one: a pull or a dialog finishing
    // must change the numbers now, so the request waits for the scan in flight and runs next.
    // One that has outlived the poll is not running at all (a task cut short, a git call that
    // never returned), so it is dropped: otherwise this flag never clears.
    if (this.scanning) {
      if (Date.now() - (this.scanAt ?? 0) < 20000) { this.rescan = true; return; }
      this.scanning = false;
    }
    this.scanning = true;
    this.scanAt = Date.now();
    this.wtGen += 1;
    const gen = (this.scanGen = (this.scanGen ?? 0) + 1);
    cx.spawn(async (cx) => {
      const out = {};
      const ids = {};
      try {
        for (const space of spaces()) {
          if (!space.folder) { out[space.id] = null; continue; }
          const on = space.machine ?? undefined;
          const cwd = space.folder;
          const at = place(space);
          // The checkout the folder is the top of. Read through git: a folder that is one level
          // under the repos root may still be a symlink, and only git says where it really is.
          const root = await this.rootOf(cwd, on);
          // Which repo the folder belongs to, and what to call it. A folder in the repos folder
          // is a repo by its path; anything else is one only while git answers for it as a
          // checkout, so a `git init` or a clone in a space's own folder becomes a repo here on
          // this scan, and stops being one the scan after its .git goes away.
          const id = await this.repoOf(cwd, on, root, at);
          // Linked vs main, as git answered: the space folder is not the repo's own checkout.
          const linked = Boolean(id) && Boolean(root) && root.replace(/\/+$/, "") !== id.replace(/\/+$/, "");
          ids[space.id] = { id, name: at.repo || (id && root ? root.slice(root.lastIndexOf("/") + 1) : ""), linked };
          const args = ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"];
          const r = await exec("git", args, { cwd, on }).catch(() => null);
          // Where the repo's own checkout is, so a worktree-only repo still gets a Main row, and
          // every checkout of it, so the panel can offer the ones no space shows yet, and how
          // far its main is from the remote's: the number the Main row carries. Only a repo has
          // those; a space without one shows its agents and nothing about a checkout.
          const main = id || cwd;
          // Main comes before anything drawn from it: a repo whose local main is gone gets it
          // back from origin's here, so the Main row always stands for a branch that exists.
          if (id) await this.ensureLocalMain(main, on);
          await this.worktreesOf(main, on);
          if (id) await this.mainGapOf(main, on);
          // Whether the repo is on GitHub yet, and what its remotes are called: what its row's
          // GitHub button is there for. Only a repo has remotes to read. The branches that remote
          // has come with it, as the last fetch left them — what a branch row's mark is missing
          // from — read once per repo per scan.
          const gh = id ? await this.remotesOf(main, on) : null;
          if (gh?.githubRemote) await this.branchesOnRemote(main, on, gh.githubRemote);
          if (!r || r.code !== 0) { out[space.id] = null; continue; }
          const info = { ahead: 0, behind: 0, dirty: 0, upstream: false, mainAhead: null, mainBehind: null, mainRef: null, branch: space.branch || null };
          for (const line of String(r.stdout).split("\n")) {
            if (line.startsWith("# branch.ab ")) {
              const [a, b] = line.slice(12).split(" ");
              info.ahead = Math.abs(parseInt(a, 10)) || 0;
              info.behind = Math.abs(parseInt(b, 10)) || 0;
              info.upstream = true;
            } else if (line && !line.startsWith("#")) info.dirty += 1;
          }
          // Several commits ahead of main, not just of origin: what a worktree still holds,
          // and what a branch has not been merged into yet — measured against the local main
          // checkout, so an unpushed main still counts.
          const ref = await this.localMain(cwd, on);
          if (ref) {
            const lr = await exec("git", ["rev-list", "--left-right", "--count", `${ref}...HEAD`], { cwd, on }).catch(() => null);
            if (lr && lr.code === 0) {
              const [onlyMain, onlyHead] = String(lr.stdout).trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
              info.mainAhead = onlyHead;
              info.mainBehind = onlyMain;
              info.mainRef = ref;
              if (!info.branch) info.branch = String(r.stdout).match(/^# branch\.head (.+)$/m)?.[1] ?? null;
            }
          }
          out[space.id] = info;
        }
      } finally {
        // A scan that a newer one overtook (only possible if this one was cancelled) applies
        // nothing: the newer scan's answer is the truth. Its flag still clears, or the panel
        // would stop scanning for good.
        const current = gen === this.scanGen;
        try {
          if (current) {
            this.git = out;
            this.ids = ids;
            await this.prune();
            this.pruneCaches();
            if (JSON.stringify(shared("spaces-tree.git") ?? null) !== JSON.stringify(out)) setShared("spaces-tree.git", out);
          }
        } finally {
          this.scanning = false;
          if (this.rescan) { this.rescan = false; cx.timer.after(50, (c) => this.scan(c)); }
          if (current) cx.notify();
        }
      }
    });
  }

  // The per-folder reads of folders no space or kept row names any more: a removed worktree or a
  // moved checkout would otherwise be answered from still. Repo-keyed caches are overwritten by
  // each scan, so they are left alone.
  pruneCaches() {
    const keep = new Set();
    const add = (folder) => { if (folder) keep.add(String(folder).replace(/\/+$/, "")); };
    for (const space of spaces()) add(space.folder);
    for (const record of Object.values(this.records())) add(record.folder);
    const stale = (key) => {
      const cut = key.indexOf("|");
      return cut >= 0 && !keep.has(key.slice(cut + 1));
    };
    for (const key of Object.keys(this.mains ?? {})) if (stale(key)) delete this.mains[key];
    for (const key of Object.keys(this.roots ?? {})) if (stale(key)) delete this.roots[key];
    for (const map of [this.mainsMiss, this.locals, this.refs, this.heals]) {
      if (!map) continue;
      for (const key of [...map.keys()]) if (stale(key)) map.delete(key);
    }
  }

  // The main checkout of the repo a folder belongs to: git's shared .git folder is the repo
  // itself for a folder inside it, and the main checkout for one of its worktrees — so every
  // space on a repo, wherever it sits, answers the same folder. Read once per machine and
  // folder: a worktree's repo does not move.
  async mainOf(cwd, on) {
    this.mains ??= {};
    this.mainsMiss ??= new Map(); // "<machine>|<folder>" -> the scan gen that answered "no repo"
    const key = `${on ?? ""}|${cwd}`;
    if (this.mains[key]) return this.mains[key];
    // A folder that is no checkout pays one rev-parse per scan, not one per space on it.
    if (this.mainsMiss.get(key) === this.wtGen) return cwd;
    const r = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }).catch(() => null);
    const common = String(r?.stdout ?? "").trim().replace(/\/+$/, "");
    const found = r && r.code === 0 && common.endsWith("/.git") ? common.slice(0, -5) : "";
    // A git that could not answer is not cached: the next scan asks again.
    if (found) return (this.mains[key] = found);
    this.mainsMiss.set(key, this.wtGen);
    return cwd;
  }

  // The repo a space's folder belongs to, as the key that says which repo it is: the folder of
  // its main checkout, or — for a folder in the repos folder git does not answer for yet — that
  // folder. "" when it is no checkout at all. The home folder and the repos folder itself are no
  // repos: they hold the spaces and the checkouts and would swallow every space under them.
  async repoOf(cwd, on, root, at) {
    if (!root) return at.repo ? `${reposRoot()}/${at.repo}` : "";
    const repos = reposRoot();
    if (root === repos || repos.startsWith(`${root}/`)) return "";
    // A plain checkout sitting right in the repos folder is its own main checkout, and a
    // symlinked path is already resolved in the root git answered: no call needed.
    if (at.repo && !at.worktree && root === cwd.replace(/\/+$/, "")) return root;
    return this.mainOf(cwd, on);
  }

  // The checkout a folder is the top of, read once per scan per folder: a space opened through
  // a symlink (this app's own home, under ~/repo) is that repo all the same.
  async rootOf(folder, on) {
    this.roots ??= {};
    const key = `${on ?? ""}|${folder}`;
    if (this.roots[key]?.gen === this.wtGen) return this.roots[key].root;
    const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: folder, on }).catch(() => null);
    const root = r && r.code === 0 ? String(r.stdout).trim().replace(/\/+$/, "") : "";
    this.roots[key] = { gen: this.wtGen, root };
    return root;
  }

  // A space's repo: the group it belongs to — the name the panel shows, and the key that says
  // which repo it is (the folder of its main checkout) — as the last scan found them. The scan
  // writes both, so a folder that becomes a checkout, or stops being one, changes group on the
  // next pass. Before the first pass, the folder's own path says what it can.
  at(space) {
    const at = place(space);
    const seen = this.ids?.[space?.id];
    return {
      repo: seen ? seen.name : at.repo,
      id: seen ? seen.id : at.repo ? `${reposRoot()}/${at.repo}` : "",
      branch: space.branch || "",
      worktree: at.worktree,
      // What menu-gh calls "linked": the scan's answer when it has one, else the path shape.
      linked: seen ? Boolean(seen.linked) : at.worktree,
    };
  }

  // One record per space, kept while it is open: what the panel needs to draw the row after the
  // space is gone. Keyed by space id, so two spaces on one folder stay two rows, and a rename or
  // a moved folder is the same row. A malformed entry is dropped rather than drawn.
  records() {
    const raw = shared(RECORDS);
    const out = {};
    if (!raw || typeof raw !== "object") return out;
    for (const record of Object.values(raw)) {
      if (!record || typeof record !== "object") continue;
      if (typeof record.id !== "string" || !record.id) continue;
      if (typeof record.folder !== "string" || !record.folder) continue;
      out[record.id] = record;
    }
    return out;
  }

  // The sighting pass, every two seconds: a record for every open space, written only when
  // something about it actually changed. Nothing is dropped because its space closed — a record
  // is what that row is made of. The pass also carries out the removals a row asked for (see
  // `spaces-tree.remove`), since it is the copy that lives as long as the window.
  sighting() {
    const stored = this.records();
    const now = Date.now();
    const liveIds = new Set(spaces().map((s) => s.id));
    // A row removed while its space was open: Herdr asks the person, and nothing is deleted
    // before they answer — a cancelled close must leave the row as it was. Once the space is
    // gone the record goes with it, and no sighting can write it back (only open spaces get
    // records). An ask nobody answered stops being asked for after REMOVE_WAIT_MS.
    const asks = shared(REMOVE);
    const requests = asks && typeof asks === "object" ? asks : {};
    const left = { ...requests };
    let leftChanged = false;
    for (const id of Object.keys(requests)) {
      if (now - Number(requests[id] ?? 0) > REMOVE_WAIT_MS) {
        delete left[id];
        leftChanged = true;
        this.asked.delete(id);
        continue;
      }
      if (!liveIds.has(id)) {
        delete left[id];
        leftChanged = true;
        this.asked.delete(id);
        this.forget(id);
        continue;
      }
      if (this.asked.has(id)) continue;
      this.asked.add(id);
      run("space.close", { id });
    }
    if (leftChanged) setShared(REMOVE, Object.keys(left).length ? left : null);
    const out = { ...stored };
    for (const space of spaces()) {
      const name = space.name ?? "";
      const folder = space.folder ?? "";
      // A space with no folder has no row to keep: a record of it could never be drawn.
      if (!folder) continue;
      const at = this.at(space);
      const machine = space.machine ?? null;
      const same = stored[space.id];
      const unchanged = same && same.name === name && same.folder === folder
        && (same.machine ?? null) === machine && JSON.stringify(same.at ?? null) === JSON.stringify(at);
      out[space.id] = unchanged ? same : { id: space.id, name, folder, machine, at, seen: now };
    }
    const ids = Object.keys(out);
    if (ids.length > KEPT_MAX) {
      const keep = new Set(ids.sort((a, b) => Number(out[b].seen ?? 0) - Number(out[a].seen ?? 0)).slice(0, KEPT_MAX));
      for (const id of ids) if (!keep.has(id)) delete out[id];
    }
    if (JSON.stringify(out) !== JSON.stringify(stored)) setShared(RECORDS, out);
  }

  // One record gone: the row with it. Written only when there was something to remove, so a
  // stray press costs no render.
  forget(id) {
    const all = this.records();
    if (!all[id]) return;
    const next = { ...all };
    delete next[id];
    setShared(RECORDS, next);
  }

  // Whether a record's folder is still there. `fs` reads the home folder, and nothing outside
  // it, so a folder elsewhere is asked of the system rather than assumed.
  async folderGone(folder) {
    try {
      return !(await fs.exists(folder));
    } catch {
      const r = await exec("test", ["-d", folder]).catch(() => null);
      return Boolean(r) && r.code !== 0;
    }
  }

  // A record whose folder is gone is a row with nothing behind it: a worktree removed, a
  // checkout deleted, a probe cleaned up. A record on another machine is left alone, since its
  // folder cannot be read from here. Runs with the scan, not with a render. A record written
  // before the scan could name its repo gets that answer here, once, so its row goes under the
  // repo it belongs to rather than under no repo at all.
  async prune() {
    const all = this.records();
    const live = new Set(spaces().map((s) => s.id));
    const next = { ...all };
    let changed = false;
    for (const record of Object.values(all)) {
      if (record.machine) continue;
      if (await this.folderGone(record.folder)) {
        delete next[record.id];
        changed = true;
        continue;
      }
      if (live.has(record.id) || record.at?.id) continue;
      const at = await this.atOf(record);
      if (!at.id) continue;
      next[record.id] = { ...record, at };
      changed = true;
    }
    if (changed) setShared(RECORDS, next);
  }

  // The repo a closed record's folder is in, asked the way the scan asks it, for a record whose
  // space closed before the scan answered.
  async atOf(record) {
    const at = place({ folder: record.folder, branch: record.at?.branch ?? "" });
    const root = await this.rootOf(record.folder);
    const id = await this.repoOf(record.folder, undefined, root, at);
    return { repo: id ? id.slice(id.lastIndexOf("/") + 1) : at.repo, id, branch: at.branch, worktree: at.worktree };
  }

  // A closed row's click: the space again, where it was, under the name it had. A folder that
  // is gone says so and takes its row with it — reopening it would only make a space in the
  // home folder or a toast. Its record goes before the space is made, so the new space's own
  // sighting writes the only record there is for it.
  async reopen(record, cx) {
    if (!record.machine && await this.folderGone(record.folder)) {
      this.forget(record.id);
      notify({ title: `${plain(record.name)} is gone`, body: `${record.folder} is no longer there — the row is removed`, level: "error" });
      cx.notify();
      return;
    }
    this.forget(record.id);
    run("space.new", { folder: record.folder, machine: record.machine ?? "", name: record.name });
  }

  keptMenu(record) {
    openOverlay({ mod: "menu-gh", kind: "popup", width: 220, height: 92, props: { tab: "kept", target: { id: record.id } } });
  }

  // The repo's own main branch as this checkout has it, with no origin in it: what a worktree
  // or branch is compared with, and where a merge lands.
  async localMain(cwd, on) {
    this.locals ??= new Map();
    const key = `${on ?? ""}|${cwd}`;
    if (this.locals.has(key)) return this.locals.get(key);
    let found = null;
    for (const ref of ["main", "master"]) {
      const r = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ref}`], { cwd, on }).catch(() => null);
      if (r && r.code === 0) { found = ref; break; }
    }
    this.locals.set(key, found);
    return found;
  }

  // The repo's own main, made from the remote's when the checkout has none: a branch is what is
  // created — nothing is checked out and no working tree is touched — and it is the only branch
  // this panel ever makes. `fetch` also reaches the remote for a main this checkout never got;
  // without it only the refs already here are used, and the look is remembered for this scan, so
  // a repo with no main costs one look per scan rather than one per space.
  async ensureLocalMain(folder, on, fetch = false) {
    if (!folder) return null;
    const seen = await this.localMain(folder, on);
    if (seen) return seen;
    this.heals ??= new Map();
    const key = `${on ?? ""}|${folder}`;
    if (!fetch && this.heals.get(key) === this.wtGen) return null;
    this.heals.set(key, this.wtGen);
    for (const local of ["main", "master"]) {
      const remote = `origin/${local}`;
      const here = await exec("git", ["rev-parse", "--verify", "--quiet", remote], { cwd: folder, on }).catch(() => null);
      let r = null;
      if (here && here.code === 0) {
        r = await exec("git", ["branch", local, remote], { cwd: folder, on }).catch(() => null);
      } else if (fetch) {
        // It was never fetched into this checkout: ask for that one branch, and let the fetch
        // write the local ref in the same move (git refuses rather than rewriting anything).
        r = await exec("git", ["fetch", "origin", `${local}:${local}`], { cwd: folder, on, timeout: 20000 }).catch(() => null);
      }
      if (!r || r.code !== 0) continue;
      // The reads that answered "no main" are what the rows were drawn from: drop them, so the
      // next render asks again rather than trusting an answer older than the branch itself.
      this.locals?.clear();
      this.refs?.clear();
      this.gaps = {};
      return local;
    }
    return null;
  }

  // The branch this repo calls main, preferring what origin has.
  async mainRef(cwd, on) {
    this.refs ??= new Map();
    const key = `${on ?? ""}|${cwd}`;
    if (this.refs.has(key)) return this.refs.get(key);
    let found = null;
    for (const ref of MAIN_REFS) {
      const r = await exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd, on }).catch(() => null);
      if (r && r.code === 0) { found = ref; break; }
    }
    this.refs.set(key, found);
    return found;
  }

  // Every local checkout of a repo, main first: `git worktree list` on its own checkout, read
  // once per scan per repo, so ten spaces of the same repo cost one call. Paths only: what a
  // checkout holds is the branch level's business.
  async worktreesOf(main, on, force = false) {
    const at = `${on ?? ""}|${main}`;
    if (!force && this.wts[at]?.gen === this.wtGen) return this.wts[at].list;
    const r = main ? await exec("git", ["worktree", "list", "--porcelain"], { cwd: main, on }).catch(() => null) : null;
    const list = [];
    if (r && r.code === 0) {
      let seen = 0;
      for (const block of String(r.stdout).split(/\n\n+/)) {
        const lines = block.split("\n");
        const path = String(lines.find((l) => l.startsWith("worktree "))?.slice(9) ?? "").replace(/\/+$/, "");
        const first = seen++ === 0;
        // A bare or prunable entry has no checkout to open: nothing to offer.
        if (!path.startsWith("/") || lines.some((l) => l === "bare" || l.startsWith("prunable"))) continue;
        const ref = lines.find((l) => l.startsWith("branch "))?.slice(7) ?? "";
        list.push({
          path,
          branch: ref.replace(/^refs\/heads\//, ""),
          head: String(lines.find((l) => l.startsWith("HEAD "))?.slice(5) ?? "").slice(0, 7),
          detached: lines.some((l) => l === "detached"),
          locked: lines.some((l) => l.startsWith("locked")),
          main: first,
        });
      }
    }
    this.wts[at] = { gen: this.wtGen, list };
    return list;
  }

  // How far a checkout's own main branch is from the remote's, read once per scan for the same
  // repo (the folder of its main checkout). It is the number that says work is committed here
  // and nowhere else — a branch merged into main whose pull request is still open. Nothing here
  // reaches the network: origin's refs are as of the last fetch.
  async mainGapOf(main, on, force = false) {
    this.gaps ??= {};
    const at = `${on ?? ""}|${main}`;
    if (!force && this.gaps[at]?.gen === this.wtGen) return this.gaps[at].gap;
    let gap = null;
    // origin/main and main, or origin/master and master: the same pair in every repo.
    const remote = main ? await this.mainRef(main, on) : null;
    const local = String(remote ?? "").replace(/^origin\//, "");
    if (String(remote ?? "").startsWith("origin/") && local) {
      const r = await exec("git", ["rev-list", "--left-right", "--count", `${remote}...${local}`], { cwd: main, on }).catch(() => null);
      if (r && r.code === 0) {
        const [onlyRemote, onlyLocal] = String(r.stdout).trim().split(/\s+/).map((n) => parseInt(n, 10) || 0);
        gap = { ahead: onlyLocal, behind: onlyRemote, local, remote };
      }
    }
    this.gaps[at] = { gen: this.wtGen, gap };
    return gap;
  }

  // The remotes a repo has, read once per scan per repo: its row offers to put the repo on
  // GitHub exactly while none of them is on github.com, and the remote that would be added is
  // the name left free — origin, or github when the checkout has an origin already. null when
  // git could not answer, so a machine that is away never shows the button by mistake.
  async remotesOf(main, on) {
    this.remotesAt ??= {};
    const key = `${on ?? ""}|${main}`;
    if (this.remotesAt[key]?.gen === this.wtGen) return this.remotesAt[key].info;
    const r = await exec("git", ["remote", "-v"], { cwd: main, on }).catch(() => null);
    const names = [];
    let github = false;
    let githubRemote = "";
    for (const line of String(r?.stdout ?? "").split("\n")) {
      const [, name, url] = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)$/) ?? [];
      if (!name) continue;
      if (!names.includes(name)) names.push(name);
      if (/github\.com[:/]/i.test(url)) {
        github = true;
        if (!githubRemote) githubRemote = name;
      }
    }
    const info = r && r.code === 0 ? { names, github, githubRemote } : null;
    this.remotesAt[key] = { gen: this.wtGen, info };
    // A remote added since the last look — this panel's own "create GitHub repo" does it —
    // must be seen by mainRef: the gap is measured against origin, not the local main.
    if (names.includes("origin") && this.refs?.has(key) && !String(this.refs.get(key)).startsWith("origin/")) this.refs.delete(key);
    return info;
  }

  // The branches a remote has, as its remote-tracking refs were after the last fetch: no network.
  // Read once per repo per scan, and null when git cannot answer, so no row offers a push of a
  // branch the remote may already have.
  async branchesOnRemote(main, on, remote) {
    this.remoteBranches ??= {};
    const key = `${on ?? ""}|${main}|${remote}`;
    if (this.remoteBranches[key]?.gen === this.wtGen) return this.remoteBranches[key].names;
    const r = await exec("git", ["for-each-ref", "--format=%(refname)", `refs/remotes/${remote}/`], { cwd: main, on }).catch(() => null);
    const names = new Set();
    const head = `refs/remotes/${remote}/`;
    if (r && r.code === 0) {
      for (const line of String(r.stdout).split("\n")) {
        const ref = line.trim();
        if (ref.startsWith(head)) names.add(ref.slice(head.length));
      }
    }
    this.remoteBranches[key] = { gen: this.wtGen, names: r && r.code === 0 ? names : null };
    return this.remoteBranches[key].names;
  }

  // What the last scan read of a repo's remotes, for its GitHub button: null while the scan has
  // not answered for the repo, or when git could not.
  remoteInfo(group) {
    return this.remotesAt?.[`${this.machineOf(group) ?? ""}|${group.id}`]?.info ?? null;
  }

  // The repo's GitHub state as the last scan read it: the remote that is on github.com ("" when
  // none is), every remote's name (the one a new repo is added as must be free), and the branches
  // the GitHub remote has — a Set, or null when git could not read them. null while the scan has
  // not answered for the repo, or when git could not say what its remotes are.
  githubOf(group) {
    const at = `${this.machineOf(group) ?? ""}|${group.id}`;
    const info = this.remotesAt?.[at]?.info;
    if (!info) return null;
    const remote = info.githubRemote ?? "";
    return {
      remote,
      names: info.names ?? [],
      branches: remote ? (this.remoteBranches?.[`${at}|${remote}`]?.names ?? null) : null,
    };
  }

  // Whether a branch has a version on the repo's GitHub remote, as the refs say: true when the
  // repo is on no GitHub at all (the repo is made with it), false when the remote has it, and
  // null when that cannot be said — no button then, rather than one that pushes blindly.
  notOnGithub(github, branch) {
    if (!github || !branch) return null;
    if (!github.remote) return true;
    return github.branches ? !github.branches.has(branch) : null;
  }

  // The machine a repo group is on: its first real space's.
  machineOf(group) {
    return group.places.find((p) => p.space)?.space?.machine ?? group.places[0]?.machine ?? group.machine ?? null;
  }

  // The checkouts to offer under a group, as the last scan left them: every worktree but the
  // repo's own, which the Main row above already shows (and opens, if no space has it yet).
  worktrees(group) {
    const key = `${this.machineOf(group) ?? ""}|${group.id}`;
    return (this.wts[key]?.list ?? []).filter((wt) => !wt.main);
  }

  // The space showing a checkout: its folder is the checkout or inside it (a shell may have
  // moved down a level), on the same machine.
  spaceAt(path, machine) {
    const dir = String(path).replace(/\/+$/, "");
    return spaces().find((s) => {
      const folder = String(s.folder ?? "").replace(/\/+$/, "");
      return (s.machine ?? null) === (machine ?? null) && (folder === dir || folder.startsWith(`${dir}/`));
    }) ?? null;
  }

  // A checkout the panel does not show as a space yet: open it the way the worktree dialog
  // does, a space on its folder. A second click while the space is being made is ignored.
  addWorktree(wt, machine, cx) {
    const existing = this.spaceAt(wt.path, machine);
    if (existing) { run("space.select", { id: existing.id }); return; }
    this.added ??= {};
    if (Date.now() - (this.added[wt.path] ?? 0) < 3000) return;
    this.added[wt.path] = Date.now();
    run("space.new", { folder: wt.path, machine: machine ?? "" });
    // The new space is a git call away: one more scan shows it in place quickly.
    cx.timer.after(1200, (cx) => this.scan(cx));
  }

  // Put a repo that so far exists only here on GitHub: the dialog asks owner, name and
  // visibility, and does the work on the repo's machine — a repo on a remote machine is made
  // there, not here. The remote it adds is origin, or github when origin is taken. `branch`, when
  // a branch row asked, is pushed too: that row wanted a GitHub version of it, not of main.
  createGithub(group, info, branch = "") {
    openOverlay({
      mod: "gh-create", kind: "dialog", width: 470, height: 340,
      props: {
        folder: group.id,
        machine: this.machineOf(group) ?? "",
        name: group.repo,
        remote: info?.names?.includes("origin") ? "github" : "origin",
        branch: pushable(branch) ? branch : "",
      },
    });
  }

  // Put one branch on the repo's GitHub remote: a push of that branch from the checkout the row
  // speaks for, its upstream set so the row's ↑↓ start working. One push per branch at a time,
  // and the numbers are read again when it returns.
  async publishBranch(place, branch, remote, cx) {
    const folder = place?.space?.folder || place?.folder || "";
    const machine = place?.space?.machine ?? place?.machine ?? null;
    if (!folder || !pushable(branch) || !pushable(remote)) return;
    this.publishing ??= new Map();
    const key = `${machine ?? ""}|${folder}|${branch}`;
    if (Date.now() - (this.publishing.get(key) ?? 0) < 5000) return;
    this.publishing.set(key, Date.now());
    const r = await exec("git", ["--no-optional-locks", "push", "--set-upstream", remote, branch],
      { cwd: folder, on: machine ?? undefined })
      .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
    const body = (r.code === 0 ? [r.stdout, r.stderr] : [r.stderr, r.stdout]).join("\n").trim()
      .split("\n").filter(Boolean).slice(-3).join("\n");
    notify({
      title: r.code === 0 ? `${branch}: on GitHub` : `${branch}: push did not run`,
      body: body || (r.code === 0 ? `pushed to ${remote}` : "git push failed"),
      level: r.code === 0 ? "success" : "error",
    });
    cx.notify();
    this.scan(cx);
  }

  // The mark a branch row carries while the branch exists only here: the repo's GitHub glyph,
  // at the row's right end, one click from a version there. Pushes the branch when the repo is
  // on GitHub already, and otherwise opens the dialog that makes the repo and pushes this branch
  // with it. The press never reaches the row's own click, which goes to the space.
  githubBranchButton(group, place, branch, github, t) {
    const key = place?.space?.id ?? `${group.key}-${branch}`;
    const tip = github.remote
      ? `${branch} has no version on GitHub — click to push it to ${github.remote}, setting its upstream`
      : `${branch} has no version on GitHub, and neither does the repo — click to make the repo there with this branch`;
    return h_flex().id(`ghb-${key}`).size(20).flex_none()
      .items_center().justify_center().rounded(6).cursor_pointer()
      .bg(alpha(t.foreground, "0f")).border(1).border_color(alpha(t.foreground, "26"))
      .hover((s) => s.bg(alpha(t.foreground, "24")).border_color(t.muted))
      .tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        if (github.remote) this.publishBranch(place, branch, github.remote, cx);
        else this.createGithub(group, github, branch);
        cx.notify();
      })
      .child(svg("mods/spaces-tree/github.svg").size(12).text_color(t.muted));
  }

  prefs() {
    const sort = shared("spaces-tree.sort");
    const only = shared("spaces-tree.only");
    return {
      sort: SORTS.some(([id]) => id === sort) ? sort : "default",
      only: ONLY.some(([id]) => id === only) ? only : "all",
    };
  }

  order(sort, list) {
    if (sort === "name") return [...list].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    if (sort === "status") return [...list].sort((a, b) => URGENCY.indexOf(a.status ?? "idle") - URGENCY.indexOf(b.status ?? "idle"));
    return list;
  }

  // Repo → its spaces → their agents. A space with no repo is its own group. The filter
  // narrows (a status, a text) and the sort reorders: both act on what is left, never on
  // the model, so a hidden agent keeps running and comes back when the filter is dropped.
  tree(prefs = this.prefs()) {
    const { sort, only } = prefs;
    const needle = String(this.query ?? "").trim().toLowerCase();
    const hit = (...parts) => !needle || parts.some((part) => String(part ?? "").toLowerCase().includes(needle));
    const all = agents();
    // One pass over the agents: each space's list is looked up, not filtered out of every agent.
    const bySpace = new Map();
    for (const agent of all) {
      const list = bySpace.get(agent.space);
      if (list) list.push(agent); else bySpace.set(agent.space, [agent]);
    }
    const groups = new Map();
    for (const space of spaces()) {
      const at = this.at(space);
      // The space itself answers the text filter (an empty filter answers nothing: it is
      // not the text that keeps a space, so a status filter can still hide it).
      const named = needle ? hit(at.repo, space.name, at.branch) : false;
      const mine = (bySpace.get(space.id) ?? [])
        .filter((agent) => only === "all" || (agent.status ?? "idle") === only)
        .filter((agent) => named || hit(nameOf(agent), agent.tab_name, agent.app));
      if (!mine.length && !named && (needle || only !== "all")) continue;
      const repoKey = at.id ? `repo:${space.machine ?? ""}|${at.id}` : `space:${space.id}`;
      // The first space on a checkout is that repo's row. Another space on the same checkout was
      // made as a workspace of its own — it is no repo at all: it keeps its name, gets no repo
      // mark and no branch level, and the checkout stays one group.
      const twin = Boolean(at.id) && !at.worktree
        && (groups.get(repoKey)?.places.some((p) => !p.at.worktree) ?? false);
      const key = twin ? `space:${space.id}` : repoKey;
      const label = plain(twin ? space.name : at.repo || space.name);
      if (!groups.has(key)) {
        groups.set(key, { key, id: twin ? "" : at.id, repo: twin ? "" : at.repo, label, places: [], agents: [], machine: space.machine ?? null });
      }
      const group = groups.get(key);
      group.machine ??= space.machine ?? null;
      group.places.push({ space, at: twin ? { repo: "", id: "", branch: at.branch || "", worktree: false } : at, agents: this.order(sort, mine) });
      group.agents.push(...mine);
    }
    // The closed rows: every space the panel has seen whose space is gone now. Nothing had to
    // notice a close — the record was written while the space was open — so a branch or a space
    // keeps its row however it died. A status filter has no agents to answer for here, and a
    // typed text has to name the row, exactly as it does for a live one.
    const live = new Set(spaces().map((s) => s.id));
    for (const record of Object.values(this.records())) {
      if (live.has(record.id)) continue;
      if (only !== "all" || (needle && !hit(record.name, record.at?.repo, record.at?.branch))) continue;
      const at = record.at ?? { repo: "", id: "", branch: "", worktree: false };
      const repo = Boolean(at.id);
      const repoKey = repo ? `repo:${record.machine ?? ""}|${at.id}` : `space:${record.id}`;
      // A second space on a checkout is a workspace of its own, exactly as it is while it is
      // open: its own group, its own name, no branch level under it.
      const twin = repo && !at.worktree && (groups.get(repoKey)?.places.some((p) => !p.at.worktree) ?? false);
      const key = twin ? `space:${record.id}` : repoKey;
      const placeAt = twin ? { repo: "", id: "", branch: at.branch || "", worktree: false } : at;
      if (!groups.has(key)) {
        const label = plain(twin || !repo ? record.name : at.repo || record.name);
        groups.set(key, {
          key, id: twin ? "" : repo ? at.id : "", repo: twin ? "" : repo ? at.repo : "", label,
          places: [], agents: [], machine: record.machine ?? null, closedRepo: repo && !twin,
        });
      }
      const group = groups.get(key);
      group.machine ??= record.machine ?? null;
      group.places.push({ space: null, kept: record, agents: [], machine: record.machine ?? null, folder: record.folder, at: placeAt });
    }
    const rank = (group) => Math.min(...group.agents.map((agent) => URGENCY.indexOf(agent.status ?? "idle")), URGENCY.length);
    const list = [...groups.values()];
    for (const group of list) {
      // Only a repo has a branch level: its own checkout, then its branches and worktrees. A
      // space made without a repo is one row — whatever its folder happens to be a checkout of
      // is not a branch of anything here — so its agents hang straight under it.
      if (group.repo) this.ensureMain(group);
    }
    if (sort === "name") list.sort((a, b) => a.label.localeCompare(b.label));
    else if (sort === "status") list.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
    else if (sort === "agents") list.sort((a, b) => b.agents.length - a.agents.length || a.label.localeCompare(b.label));
    return list;
  }

  // A worktree folder is a repo's by construction; a plain checkout needs git to answer. A
  // group made only of closed rows said so when it was made: its record carried the repo.
  isRepo(group) {
    if (group.closedRepo) return true;
    return group.places.some((p) => p.at.worktree || (p.space && this.git[p.space.id]));
  }

  // The repo's main checkout is always one of its rows, labelled Main: with a space on it
  // when there is one, otherwise as the way back to it. A folder that is not a git repo has
  // no main checkout, so nothing is added there.
  ensureMain(group) {
    if (!this.isRepo(group)) return;
    const open = group.places.find((p) => p.space && !p.at.worktree);
    // The repo's own checkout is the Main row only while it is on the main branch: an agent
    // working on a branch there leaves main with no checkout, and main still gets its row.
    const openInfo = open?.space ? this.git[open.space.id] : null;
    const mainName = openInfo?.mainRef || "main";
    const openOnMain = !openInfo?.branch || openInfo.branch === mainName;
    // Main checked out somewhere of its own — a worktree on it — is that space: the Main row is
    // then the space a press lands in, and it lights up while the person is in it. When that space
    // was closed, its record is the Main row instead of a row of its own: one Main, never a Main
    // and a "main" beside it.
    const holder = open && !openOnMain
      ? group.places.find((p) => p.space && p.at.worktree
        && plain(this.git[p.space.id]?.branch || p.at.branch || "") === mainName)
      : null;
    const closedMain = open && !openOnMain && !holder
      ? group.places.find((p) => p.kept && p.at.worktree && plain(p.at.branch || "") === mainName)
      : null;
    if (open && openOnMain) {
      open.main = true;
    } else if (holder) {
      holder.main = true;
    } else if (closedMain) {
      closedMain.main = true;
    } else if (open) {
      // That checkout is on a branch and main is checked out nowhere: it gets a row of its own
      // above it — no space, since no space is on it, one press from a checkout of its own.
      group.places.unshift({
        space: null, agents: [], main: true, openFrom: open,
        machine: open.space.machine ?? null,
        folder: open.space.folder || open.folder,
        at: { repo: group.repo, id: group.id, branch: "", worktree: false },
      });
    } else {
      const machine = group.places[0]?.space?.machine ?? group.places[0]?.machine ?? group.machine ?? null;
      // A space on the main checkout can be hidden by the filter and still exist: reuse it.
      const main = spaces().find((s) => {
        const at = this.at(s);
        return at.id === group.id && !at.worktree && (s.machine ?? null) === machine;
      });
      // A closed space on the checkout says what Main would: one row, and it opens the same space
      // again. Main is only drawn when nothing else holds this folder, so the row the person had
      // never goes away in favour of the generic one — and it is Main, house and all, like every
      // other row that holds the repo's main: one rule for the whole tree.
      const covers = main ? null : group.places.find((p) => p.kept && !p.at.worktree && p.folder === (group.id || p.at.id));
      if (covers) {
        covers.main = true;
        return;
      }
      group.places.unshift({
        space: main ?? null, agents: [], main: true, machine,
        folder: main?.folder || group.id,
        at: main ? this.at(main) : { repo: group.repo, id: group.id, branch: "", worktree: false },
      });
    }
    group.places.sort((a, b) => Number(Boolean(b.main)) - Number(Boolean(a.main)));
  }

  // The agents of one list, in the four states a row counts, in one pass.
  bucket(list) {
    const out = { blocked: [], working: [], done: [], idle: [] };
    for (const agent of list) {
      const status = agent.status ?? "idle";
      (out[status] ?? out.idle).push(agent);
    }
    return out;
  }

  // A colored chip: dot + count, tinted by what it means, with the agents it counts on hover.
  statusChip(status, list, t) {
    const count = list.length;
    const color = status === "idle" ? t.muted : (t[status] ?? t.dim);
    const names = list.map((a) => plain(a.program?.name) || plain(a.tab_name) || "terminal").join(", ");
    return h_flex().h(19).px(6).gap(4).items_center().rounded(10).flex_none()
      .bg(alpha(color, "18")).border(1).border_color(alpha(color, "40"))
      .tooltip(`${count} ${status}: ${names}`)
      .child(div().size(6).flex_none().rounded(3).bg(color))
      .child(div().text_size(11.5).font_semibold().text_color(color).child(String(count)));
  }

  chips(by, t) {
    return h_flex().gap(4).flex_none().children(URGENCY
      .filter((status) => by[status].length > 0)
      .map((status) => this.statusChip(status, by[status], t)));
  }

  // A small chip for the branch level's numbers: distance from origin, uncommitted, from main.
  // `action` ({ id, onClick }) makes it a button (commit the changes, merge the branch); its
  // press never reaches the row's own click, which goes to the space.
  bit(text, color, t, tip, action) {
    const el = () => h_flex().h(19).px(5).items_center().rounded(10).flex_none().bg(alpha(color, "1a"))
      .border(1).border_color(alpha(color, "4d")).when(Boolean(tip), (b) => b.tooltip(tip))
      .child(div().text_size(11.5).font_medium().text_color(color).child(text));
    if (!action) return el();
    return el().id(action.id).cursor_pointer()
      .hover((s) => s.bg(alpha(color, "33")))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { action.onClick(); cx.notify(); });
  }

  // ↑ahead ↓behind, always there (dim at zero, so the numbers are never a surprise); ✎uncommitted
  // when there is any; how far from main; and whether the branch was ever pushed. `hideOrigin`
  // says the repo row's chip already carries the same numbers (it does, when this row is the
  // repo's own checkout sitting on its main branch): one place, and that one pushes and pulls.
  gitBits(info, t, space, hideOrigin = false) {
    if (!info) return [];
    const bits = [];
    if (info.upstream) {
      // Only when it is not in step: a chip that says ↑0 ↓0 is noise.
      if (!hideOrigin && (info.ahead > 0 || info.behind > 0)) {
        // The ↑ is the way out: it opens the push window. The ↓ has no window of its own.
        bits.push(h_flex().h(19).px(5).gap(3).items_center().rounded(10).flex_none().bg(alpha(t.border, "33"))
          .border(1).border_color(alpha(t.border, "88"))
          .when(info.ahead > 0, (el) => el.id(`push-${space.id}`).cursor_pointer()
            .hover((s) => s.bg(alpha(t.ansi2, "2b"))).border_color(alpha(t.ansi2, "66"))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { this.gitDialog(space, "push"); cx.notify(); }))
          .tooltip(`${info.ahead} to push${info.ahead > 0 ? " (click to push)" : ""}, ${info.behind} to pull — not in step with the branch's upstream, as of the last fetch`)
          .when(info.ahead > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.ansi2).child(`↑${info.ahead}`)))
          .when(info.behind > 0, (el) => el.child(div().text_size(11.5).font_medium().text_color(t.ansi1).child(`↓${info.behind}`))));
      }
    } else {
      bits.push(this.bit("local", t.muted, t, "no upstream: nothing of this branch is on a remote"));
    }
    if (info.dirty > 0) {
      bits.push(this.bit(`✎${info.dirty}`, t.ansi3, t, `${info.dirty} changed or untracked paths, not committed — click to commit them`,
        { id: `dirty-${space.id}`, onClick: () => this.gitDialog(space, "commit") }));
    }
    // Compared with main: green when this branch holds commits main does not, red when it is
    // missing main's. Nothing to say on the main branch itself — there the arrows are the answer.
    // A gap either way is worth a window: ahead means commits to bring in, behind means main
    // has moved and the branch does not know yet. Both open the same merge, which says which.
    if ((info.mainAhead > 0 || info.mainBehind > 0) && info.branch !== info.mainRef) {
      // Against the local main branch, the one a merge writes and the one this row is a branch
      // of: origin is the Main row's business, so nothing here waits for a fetch to be true.
      const said = `${info.mainAhead} commit${info.mainAhead === 1 ? "" : "s"} on this branch that local ${info.mainRef} does not have, ${info.mainBehind} on local ${info.mainRef} that this branch does not have`;
      const label = info.mainAhead >= info.mainBehind ? `main+${info.mainAhead}` : `main−${info.mainBehind}`;
      bits.push(this.bit(label, info.mainAhead >= info.mainBehind ? t.ansi2 : t.ansi1, t,
        `Compared with the local ${info.mainRef} checkout (not origin): ${said} — click to merge ${info.branch} into it`,
        { id: `main-${space.id}`, onClick: () => this.gitDialog(space, "merge") }));
    }
    return bits;
  }

  // What a row that speaks for a checkout says: how far its main is from the remote's (when the
  // row is that main), the branch's own distance from its upstream, what is not committed, and
  // how far the branch is from main. The gap chip carries the ↑↓ itself, so the row's own pair
  // would only repeat those numbers.
  checkoutBits(place, t, withGap) {
    const space = place?.space ?? null;
    const info = space ? this.git[space.id] : null;
    const gap = withGap ? this.gapOf(place) : null;
    const bits = this.gitBits(info, t, space, Boolean(gap) && info?.branch === gap.local);
    const measured = gap ? this.mainGapBits(place, t) : null;
    if (measured) bits.unshift(measured);
    return bits;
  }

  // The Main row's own numbers: how far the repo's local main is from the remote's, and the one
  // click that closes the gap — ↑ opens the push window for that checkout, ↓ pulls it (--ff-only,
  // which never merges or rewrites). Nothing when the two are in step; origin's refs are as of
  // the last fetch.
  mainGapBits(place, t) {
    const gap = this.gapOf(place);
    if (!gap || (!gap.ahead && !gap.behind)) return null;
    const key = place.space?.id ?? `main-${place.at?.repo || place.folder}`;
    const said = gap.ahead && gap.behind ? `${gap.ahead} to push (click), ${gap.behind} to pull (click)`
      : gap.ahead ? `${gap.ahead} committed here, not on ${gap.remote} — click to push`
        : `${gap.behind} on ${gap.remote}, not pulled — click to pull`;
    return h_flex().h(16).px(3).gap(1).flex_none().items_center().rounded(8)
      .bg(alpha(t.border, "33")).border(1).border_color(alpha(t.border, "88"))
      .tooltip(`local ${gap.local} vs ${gap.remote} — ${said} (as of the last fetch)`)
      .when(gap.ahead > 0, (el) => el.child(h_flex().id(`gap-push-${key}`).px(2).rounded(6).cursor_pointer()
        .hover((s) => s.bg(alpha(t.ansi2, "2b")))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.mainDialog(place, "push"); cx.notify(); })
        .child(div().text_size(10.5).font_medium().text_color(t.ansi2).child(`↑${gap.ahead}`))))
      .when(gap.behind > 0, (el) => el.child(h_flex().id(`gap-pull-${key}`).px(2).rounded(6).cursor_pointer()
        .hover((s) => s.bg(alpha(t.ansi1, "2b")))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.pull(place, cx); })
        .child(div().text_size(10.5).font_medium().text_color(t.ansi1).child(`↓${gap.behind}`))));
  }

  // That gap as the last scan left it, by the folder of the repo's main checkout: the key
  // every space of the repo agrees on.
  gapOf(place) {
    const machine = place?.space?.machine ?? place?.machine ?? null;
    const folder = String(place?.space?.folder || place?.folder || "").replace(/\/+$/, "");
    const key = place?.at?.id || folder;
    return this.gaps?.[`${machine ?? ""}|${key}`]?.gap ?? null;
  }

  // The checkout the Main row's chips act on: its space when it has one, else the folder the
  // panel opens for it.
  checkoutOf(place) {
    return {
      folder: place?.space?.folder || place?.folder || "",
      machine: place?.space?.machine ?? place?.machine ?? null,
      name: plain(place?.at?.repo || place?.space?.name || place?.folder || "checkout"),
    };
  }

  // The push window for that checkout, opened the way a space's is (and with the same
  // one-at-a-time mark, so a double click cannot stack two).
  mainDialog(place, action) {
    const { folder, machine, name } = this.checkoutOf(place);
    if (!folder) return;
    const opened = Number(shared("space-git.open") ?? 0);
    if (opened && Date.now() - opened < 2000) return;
    setShared("space-git.open", Date.now());
    const gap = this.gapOf(place);
    openOverlay({
      mod: "space-git", kind: "dialog", width: 760, height: 560,
      props: { folder, machine: machine ?? "", action, branch: gap?.local ?? "", mainRef: gap?.local ?? name },
    });
  }

  // The one write that has no window: --ff-only never makes a merge commit and never rewrites,
  // so it either fast-forwards main or says why it will not. One pull per checkout at a time,
  // and the row answers it before any scan.
  async pull(place, cx) {
    this.pulling ??= new Set();
    const { folder, machine, name } = this.checkoutOf(place);
    if (!folder || this.pulling.has(folder)) return;
    this.pulling.add(folder);
    try {
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "pull", "--ff-only"],
        { cwd: folder, on: machine ?? undefined }).catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
      const body = (r.code === 0 ? r.stdout : `${r.stdout}\n${r.stderr}`).trim().split("\n").filter(Boolean).slice(-3).join("\n");
      notify({
        title: r.code === 0 ? `${name}: pulled` : `${name}: pull did not run`,
        body: body || "already up to date",
        level: r.code === 0 ? "success" : "error",
      });
    } finally {
      this.pulling.delete(folder);
      // This checkout's numbers are read again now, then the rest of the panel follows.
      await this.mainGapOf(place?.at?.id || folder, machine ?? undefined, true);
      cx.notify();
      this.scan(cx);
    }
  }

  // The commit and merge dialogs act on this space's folder: the window reads the diff and
  // the commits itself, so nothing about them is decided here.
  gitDialog(space, action) {
    // One at a time: Herdr stacks a second copy of the same dialog over the first, so a
    // double click must not open two. The window is a click's length: a dialog that ends
    // without saying so (the app killed, a crash) must not leave the chips dead for minutes.
    const opened = Number(shared("space-git.open") ?? 0);
    if (opened && Date.now() - opened < 2000) return;
    setShared("space-git.open", Date.now());
    const info = this.git[space.id];
    openOverlay({
      mod: "space-git", kind: "dialog", width: 760, height: 560,
      props: { folder: space.folder, machine: space.machine ?? "", action, branch: info?.branch ?? space.branch, mainRef: info?.mainRef },
    });
  }

  // Right-click keeps what the shipped spaces panel offered: the space's own menu (rename,
  // worktrees, close), and on an agent the pane's (split, zoom, close).
  spaceMenu(space) {
    // The panel already knows whether this space is a checkout and which kind: the scan reads it
    // from git (a linked worktree may live anywhere), so the menu does not ask again.
    const at = this.at(space);
    const git = at.id ? (at.linked ? "linked" : "main") : null;
    openOverlay({ mod: "menu-gh", kind: "popup", width: 220, height: 280, props: { tab: "space", git, target: { id: space.id } } });
  }

  paneMenu(agent) {
    openOverlay({ mod: "menu", kind: "popup", width: 220, height: 280, props: { tab: "pane", target: { pane: agent.pane, terminal: agent.address } } });
  }

  // A new space: its name is asked first (space-new), then it opens here on the folder of its
  // own that the dialog makes, or on the repo it makes on main. Nothing is made before the
  // name is taken.
  addSpace() {
    openOverlay({ mod: "space-new", kind: "dialog", width: 430, height: 286 });
  }

  toggle(key, cx) {
    if (this.closed.has(key)) this.closed.delete(key); else this.closed.add(key);
    cx.notify();
  }

  // The row the pointer is on, as `on_hover` reports it. A container the shell only styles with
  // `hover` — a space's box — is answered once the pointer rests, half a second later, together
  // with its tooltip; a row with handlers of its own is answered at once. So the box takes its
  // pointer state from the row inside it, and this is that state. A row clears only its own mark:
  // crossing from a row to a child of it must not put the child out on the way.
  hot(key, on, cx) {
    if (on) {
      if (this.under === key) return;
      this.under = key;
    } else {
      if (this.under !== key) return;
      this.under = "";
    }
    cx.notify();
  }

  // Whether one of these names owns the pointer now: a space's box is lit by its own row and by
  // every agent row it holds, so pointing at an agent says which space it belongs to.
  pointsAt(...keys) {
    return keys.includes(this.under);
  }

  // The mark a group row starts with: the repo's initials in its own color — also for a space
  // that lives on a repo's checkout but is a workspace of its own — or a folder when the space
  // belongs to no repo at all.
  groupMark(group, t) {
    const repo = group.repo || "";
    const tile = div().size(24).flex_none().rounded(8).flex().items_center().justify_center()
      .border(1).border_color(alpha(t.foreground, "1a"));
    if (!repo) {
      return tile.bg(t.raised)
        .child(svg("mods/spaces-tree/folder.svg").size(13).text_color(t.muted));
    }
    return tile.bg(tintOf(repo, t))
      .child(div().text_size(11.5).font_semibold().text_color(t.background).child(INITIALS(repo)));
  }

  // A repo as the tree's first level: colored initials, its name, what sits under it, and the
  // one + that makes another branch in it.
  groupRow(group, t) {
    const open = !this.closed.has(group.key);
    const mine = group.agents;
    const by = this.bucket(mine);
    const summary = URGENCY.filter((s) => by[s].length).map((s) => `${by[s].length} ${s}`).join(", ");
    // One space on a plain folder is its own row: no branch level below it, so the numbers a
    // branch row would carry are said here — and the row goes to the space, with the chevron
    // left to fold it, since there is no space row below to click.
    const solo = group.repo ? null : group.places[0]?.space ?? null;
    // A space with no repo whose space has closed: this row is the whole of it, so the row is
    // where it is opened again and where it is removed from.
    const kept = group.repo ? null : group.places[0]?.kept ?? null;
    const what = solo ? "a space" : kept ? "a closed space" : `${group.places.length} ${group.places.length === 1 ? "branch" : "branches"}`;
    const tip = `${group.label} — ${what}, ${mine.length} ${mine.length === 1 ? "agent" : "agents"}${summary ? ` (${summary})` : ""}`
      + (solo ? `\n${solo.folder} — click to go to the space, the chevron folds it` : "")
      + (kept ? `\n${kept.folder} — closed, click to open it again; right-click to remove it` : "");
    const worktrees = this.worktrees(group);
    const loose = worktrees.filter((wt) => !this.spaceAt(wt.path, this.machineOf(group))).length;
    // A repo with no remote on github.com can be put there from its own row: the button speaks
    // for the repo, not for a space, and is absent once one of its remotes is on GitHub.
    const gh = group.repo ? this.remoteInfo(group) : null;
    // A repo's row is the tree's first level and stands on the panel; a space with no repo is a
    // group head of the same kind, with its agents under the rail below it.
    return h_flex().id(`g-${group.key}`).h(36).flex_none().px(8).gap(8).items_center().rounded(8)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(tip)
      .on_click((_e, cx) => {
        if (solo) run("space.select", { id: solo.id });
        else if (kept) this.reopen(kept, cx);
        else this.toggle(group.key, cx);
        cx.notify();
      })
      // The first place can be the Main row of a repo with no space on its checkout, so the
      // menu belongs to the first real space of the group, not to places[0].
      .on_mouse_down("right", () => {
        const first = group.places.find((p) => p.space)?.space;
        if (first) this.spaceMenu(first);
        else if (kept) this.keptMenu(kept);
      })
      .when(Boolean(solo), (el) => el.child(h_flex().id(`fold-${group.key}`).size(14).flex_none()
        .items_center().justify_center().cursor_pointer().rounded(4).hover((x) => x.bg(t.raised))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.toggle(group.key, cx))
        .child(svg(`mods/spaces-tree/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).text_color(t.dim))))
      .when(!solo, (el) => el.child(svg(`mods/spaces-tree/${open ? "chevron-down" : "chevron-right"}.svg`).size(12).flex_none().text_color(t.dim)))
      // Initials belong to a repo: a space row is its name, and the room goes to its numbers.
      .child(this.groupMark(group, t))
      .child(div().flex_1().min_w(0).truncate().text_size(13.5).font_semibold().text_color(kept ? t.muted : t.foreground).child(group.label))
      // A space on a plain folder has no branch row below it: the bot that starts an agent on
      // it belongs on the row that names it.
      .when(Boolean(solo), (el) => el.child(this.agentButton(solo, t)))
      // The repo mark GitHub uses, right of the name: this space is a repo of its own.
      .when(Boolean(group.repo), (el) => el.child(h_flex().flex_none().items_center()
        .tooltip(`repo: ${group.repo}`)
        .child(svg("mods/spaces-tree/repo.svg").size(13).text_color(t.muted))))
      .when(mine.length > 0, (el) => el.child(this.chips(by, t)))
      // A dropdown rather than a row in the tree: the checkouts exist whether or not they
      // are open as spaces, and they should not push the spaces down.
      .when(worktrees.length > 0, (el) => el.child(this.worktreesButton(group, worktrees, loose, t)))
      // The repo has no github.com remote yet: one click opens the dialog that makes it, with
      // the main checkout, its machine and a remote name that is free.
      .when(Boolean(gh) && !gh.github, (el) => el.child(h_flex().id(`gh-${group.key}`).size(20).flex_none()
        .items_center().justify_center().rounded(6).cursor_pointer()
        .bg(alpha(t.foreground, "0f")).border(1).border_color(alpha(t.foreground, "26"))
        .hover((s) => s.bg(alpha(t.foreground, "24")).border_color(t.muted))
        .tooltip(`${group.label} ${gh.names.length ? `has only ${gh.names.join(", ")}` : "has no remote"} — click to create its GitHub repo`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.createGithub(group, gh); cx.notify(); })
        .child(svg("mods/spaces-tree/github.svg").size(12).text_color(t.muted))))
      // Branches belong to repos: a space made without one gets no "new worktree" either.
      .when(Boolean(group.repo), (el) => el.child(h_flex().id(`nw-${group.key}`).size(20).flex_none()
        .items_center().justify_center().rounded(6).cursor_pointer()
        .bg(alpha(t.accent, "12")).border(1).border_color(alpha(t.accent, "4d"))
        .hover((s) => s.bg(alpha(t.accent, "2e")).border_color(t.accent))
        .tooltip(`New worktree or branch in ${group.label}`)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { this.newWorktree(group); cx.notify(); })
        .child(svg("mods/spaces-tree/plus.svg").size(11).text_color(t.accent))));
  }

  // A branch or worktree: the space, its icon (a house for the repo's own checkout, a branch
  // for the others), its distance from origin and main. Its agents are counted one level up,
  // on the repo, and listed one level down, under their own rail.
  placeRow(group, place, t, fallback = null) {
    const { space, at } = place;
    // A closed space's row: the record is all there is, so there is no live info and no chips.
    const kept = place.kept ?? null;
    const folder = space?.folder || place.folder || "";
    const machine = space?.machine ?? place.machine ?? null;
    const info = space ? this.git[space.id] : null;
    const active = Boolean(space?.active);
    // The row is called Main only while the repo's own checkout is really on main: an agent
    // that works on a branch in that checkout is that branch here too, whatever the folder is.
    const branch = plain(info?.branch || at.branch || "");
    const mainName = info?.mainRef || "";
    // A row holds the repo's Main when the flag says so (the checkout, the worktree on main, a
    // closed one of either, the row drawn for a main nobody has checked out) or when the branch
    // it speaks for is the local main: one icon and one name for all of them.
    const onMain = Boolean(place.main)
      || Boolean(branch && mainName && branch === mainName && (space || kept));
    const label = onMain ? "Main" : branch || (at.worktree ? "worktree" : "main");
    // The Main row is the repo's own checkout, so the branch living there is the local one —
    // what the repo row's ↑↓ compare with origin is its remote-tracking counterpart, and a
    // merge opened from another branch lands here, not on the remote.
    const elsewhere = place.openFrom?.space ? plain(this.git[place.openFrom.space.id]?.branch || "") : "";
    const tip = kept
      ? plain(kept.name) + (branch ? ` — ${plain(branch)}` : "") + (folder ? ` — ${folder}` : "")
        + "\nclosed: no agents — click to open the space again, right-click to remove it"
      : plain(place.main
      ? !space && place.openFrom
        ? `Main — the local ${mainName || "main"} branch of this repo: ${folder}`
          + `\nno working tree has it checked out${elsewhere ? ` — ${place.openFrom.space.name} is on ${elsewhere}` : ""}`
          + `\nclick to open it on a checkout of its own (${WORKTREES().replace(home(), "~")}/<repo>/${branchDir(mainName || "main")})`
        : onMain
          ? (place.at.worktree
            ? `Main — a worktree on this repo's local ${branch || "main"}: ${folder}`
              + "\nclick to go there; merges into main land here"
            : `Main (local) — this repo's own checkout, on the local branch ${branch || "main"}: ${folder}`
              + `${space ? "" : "\nclick to open it as a space"}`
              + "\nmerges from other branches land here")
          : `${branch} — this repo's own checkout, working on a branch, not on ${mainName || "main"}: ${folder}`
            + "\nmerges into main land in this checkout"
      : `${space.name}${folder ? ` — ${folder}` : ""}`);
    const key = space?.id ?? kept?.id ?? `main-${at.id || at.repo}`;
    const icon = onMain ? "house" : at.worktree || branch ? "git-branch" : "folder";
    // The branch this row speaks for, when it speaks for one: the space's own, or — for the Main
    // row no space sits on — the repo's local main, which is the branch that row is.
    const mainOn = place.openFrom?.space ? this.git[place.openFrom.space.id]?.mainRef : "";
    const local = branchName(space ? branch : mainOn);
    // A branch that exists only here carries the mark that gives it a version on GitHub: the
    // repo's only when that is where the branch would go too.
    const github = this.githubOf(group);
    const missing = this.notOnGithub(github, local);
    // The card this line lives in draws the perimeter, the accent and the fill (spaceCard): the
    // row keeps only what is the line's own, and the padding that puts icon, label and chips
    // exactly where they were when a 2px bar stood on this edge.
    return h_flex().id(`s-${key}`).h(28).flex_none().pl(10).pr(7).gap(7).items_center()
      .cursor_pointer()
      .on_hover((on, cx) => this.hot(`s-${key}`, on, cx))
      .tooltip(tip)
      .on_click((_e, cx) => {
        if (space) run("space.select", { id: space.id });
        else if (kept) this.reopen(kept, cx);
        else if (place.main) this.goMain(place, cx);
      })
      .on_mouse_down("right", () => {
        if (kept) { this.keptMenu(kept); return; }
        const target = space ?? fallback;
        if (target) this.spaceMenu(target);
      })
      .child(svg(`mods/spaces-tree/${icon}.svg`).size(13).flex_none()
        .text_color(active ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family("JetBrains Mono")
        .text_color(kept ? t.dim : active ? t.foreground : t.muted).child(label))
      .when(Boolean(space), (el) => el.child(this.agentButton(space, t)))
      .when(Boolean(machine), (el) => el.child(h_flex().h(16).px(4).flex_none().items_center().rounded(4)
        .bg(t.raised).child(div().text_size(11).text_color(t.muted).child(machine))))
      .children(this.checkoutBits(place, t, Boolean(place.main)))
      .when(missing === true, (el) => el.child(this.githubBranchButton(group, place, local, github, t)));
  }

  // The one click that starts an agent on this branch: the tab bar's own + menu, opened at the
  // icon (a popup's `at` is the pointer) and told which space to start in, so the agent lands on
  // this branch, not in whichever space happens to be shown.
  agentButton(space, t) {
    // Lit while its menu is up: the row says on or off, and the same shared record the press
    // reads is what puts the light out.
    const mark = shared(BRANCH_MENU);
    const open = Boolean(mark && mark.space === space.id && !mark.closed);
    return h_flex().id(`na-${space.id}`).h(18).px(4).flex_none().items_center().rounded(6).cursor_pointer()
      .bg(open ? t.selected : alpha(t.foreground, "0f"))
      .border(1).border_color(open ? t.input : alpha(t.foreground, "26"))
      .hover((s) => s.bg(t.hover).border_color(t.input))
      .when(!open, (el) => el.tooltip(`Start an agent on ${plain(space.name)} — the + menu, on this branch's space`))
      .on_size_change((size) => { this.botSize = size; })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        this.pressedAt = Date.now();
        this.iconCentre = iconCentre(e, this.botSize);
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const now = Date.now();
        const press = this.pressedAt || now;
        const at = this.iconCentre;
        this.pressedAt = 0;
        this.iconCentre = null;
        const mark = shared(BRANCH_MENU);
        const mine = mark && mark.space === space.id ? mark : null;
        // The menu is up for this row: this press closes it. Whichever gets there first — the
        // popup's own outside-press dismissal (which stamps `closed` at this very press) or this
        // click (which closes the overlay itself) — the row ends up shut, never reopened.
        if (mine && !mine.closed) {
          if (mine.overlay) closeOverlay(mine.overlay);
          setShared(BRANCH_MENU, { space: space.id, overlay: mine.overlay ?? null, at: now, closed: true });
          cx.notify();
          return;
        }
        // Dismissed by this same press: the menu is already gone, so nothing opens back up. A
        // record stamped before the press is a menu that closed earlier (a click elsewhere):
        // that press means "open again".
        if (mine && mine.at >= press - 30) { cx.notify(); return; }
        const overlay = openOverlay({
          mod: "new-menu-pinned", kind: "popup", width: 264, height: 500, frame: "none",
          at: at ?? "pointer",
          props: { space: space.id, comic: true },
        });
        setShared(BRANCH_MENU, { space: space.id, overlay, at: now, closed: false });
        cx.notify();
      })
      .child(svg("icons/agent.svg").size(13).text_color(open ? t.foreground : t.muted));
  }

  // Main always goes to the local main: the space whose checkout has it, a space on a worktree
  // that has it, or — when no checkout has it — a worktree made for it now, where the worktree
  // dialog puts them (~/.herdr/worktrees/<repo>/<branch>). The branch is made first when the
  // repo has none at all, so a press on Main never lands on nothing. One press per repo at a
  // time: the git calls take a moment, and a second press would ask for a second checkout.
  goMain(place, cx) {
    const folder = place?.folder || place?.space?.folder || "";
    const machine = place?.machine ?? place?.space?.machine ?? null;
    if (!folder) return;
    this.openingMain ??= new Set();
    if (this.openingMain.has(folder)) return;
    this.openingMain.add(folder);
    const repo = plain(place?.at?.repo || folder.slice(folder.lastIndexOf("/") + 1));
    cx.spawn(async (cx) => {
      try {
        const local = await this.ensureLocalMain(folder, machine, true);
        if (!local) {
          notify({
            title: "No local main",
            body: `${folder} has no main (or master) branch, and origin's has none to make one from.`,
            level: "error",
          });
          return;
        }
        const list = await this.worktreesOf(folder, machine, true);
        let at = list.find((wt) => !wt.detached && wt.branch === local) ?? null;
        if (!at) {
          const path = `${WORKTREES()}/${branchDir(repo) || "repo"}/${branchDir(local) || local}`;
          // The one write this row makes: git refuses a second checkout of one branch, so a
          // checkout that already holds main is the one the list above found.
          const r = await exec("git", ["worktree", "add", path, local],
            { cwd: folder, on: machine ?? undefined, timeout: 120000 })
            .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
          if (!r || r.code !== 0) {
            notify({
              title: `${local}: no checkout to open`,
              body: (String(r?.stderr ?? "") || String(r?.stdout ?? "")).trim().split("\n").slice(-2).join("\n")
                || "git worktree add failed",
              level: "error",
            });
            return;
          }
          at = { path, branch: local };
        }
        // A space on it, or the one already there moved to: the next scan draws it as the repo's
        // Main row, and from then on this press is a plain select.
        this.addWorktree(at, machine, cx);
        cx.notify();
      } finally {
        this.openingMain.delete(folder);
      }
    });
  }

  // A new branch on a checkout of its own, made by the same worktree dialog the space menu
  // opens. It starts from the repo's main checkout, the one row a repo always has.
  newWorktree(group) {
    const first = group.places[0]?.space;
    const machine = first?.machine ?? group.places[0]?.machine ?? null;
    // The repo's main checkout, whether its space sits on it or the row above it is empty.
    const folder = group.id || first?.folder || group.places[0]?.folder;
    if (!folder) return;
    openOverlay({ mod: "worktree-gh", kind: "dialog", width: 460, height: 300, props: { folder, machine, action: "new" } });
  }

  // The checkouts of a repo, in a menu from a small button beside its +: what exists on
  // disk can be opened as a space without the list carrying a row for it. The count on the
  // button turns accent when some checkout is not a space yet.
  worktreesButton(group, list, loose, t) {
    const open = this.wtMenu === group.key;
    const what = `${list.length} worktree${list.length === 1 ? "" : "s"}`
      + (loose ? ` — ${loose} not open as ${loose === 1 ? "a space" : "spaces"}` : " — all open as spaces");
    const trigger = h_flex().id(`wtb-${group.key}`).h(20).px(5).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .bg(open ? alpha(t.accent, "1c") : t.raised)
      .border(1).border_color(open ? t.accent : t.border)
      .hover((s) => s.bg(t.hover))
      .tooltip(`${group.label}: ${what}`)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => cx.stop_propagation())
      .child(svg("mods/spaces-tree/git-branch.svg").size(11).text_color(open ? t.accent : t.muted))
      .child(div().text_size(10.5).font_medium().text_color(loose ? t.accent : t.muted).child(String(list.length)));
    return Popover.new(`wt-pop-${group.key}`)
      .trigger(trigger)
      .anchor("top_right")
      .open(open)
      .on_open_change((value, cx) => {
        // Closing another group's menu must not clear the one just opened.
        if (value) this.wtMenu = group.key;
        else if (this.wtMenu === group.key) this.wtMenu = "";
        cx.notify();
      })
      // Built only while it is open: a closed popover is a row with no menu behind it.
      .when(open, (el) => el.content(this.worktreesMenu(group, list, loose, t)));
  }

  worktreesMenu(group, list, loose, t) {
    const machine = this.machineOf(group);
    return v_flex().id(`wt-menu-${group.key}`).w(270).p(4).gap(1).rounded(8).bg(t.popover)
      .border_1().border_color(t.border).shadow_lg().text_size(12.5)
      .child(h_flex().h(24).flex_none().px(6).gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(t.muted)
          .child(`${group.label.toUpperCase()} · WORKTREES`))
        .child(h_flex().h(16).px(4).flex_none().items_center().rounded(4).bg(t.raised)
          .child(div().text_size(10.5).text_color(t.muted).child(String(list.length))))
        .when(loose > 0, (el) => el.child(h_flex().h(16).px(4).flex_none().items_center().rounded(4)
          .bg(alpha(t.accent, "1c")).border(1).border_color(alpha(t.accent, "4d"))
          .child(div().text_size(10.5).font_medium().text_color(t.accent).child(`+${loose}`)))))
      .child(v_flex().max_h(300).overflow_y_scrollbar().gap(1)
        .children(list.map((wt) => this.worktreeRow(group, wt, machine, t))));
  }

  worktreeRow(group, wt, machine, t) {
    const space = this.spaceAt(wt.path, machine);
    const label = wt.detached ? `detached @${wt.head}` : plain(wt.branch);
    // A checkout is a local branch too: one no GitHub remote has gets the same one-click mark
    // a branch row in the tree carries, and pushing it from this checkout is what that does.
    const branch = wt.detached ? "" : branchName(wt.branch);
    const github = this.githubOf(group);
    const missing = this.notOnGithub(github, branch);
    const tip = `${label || "worktree"}${wt.locked ? " — locked" : ""}\n${wt.path}\n${space ? `open as ${plain(space.name)} — click to go there` : "click to open it as a space"}`;
    return h_flex().id(`w-${group.key}-${wt.path}`).h(26).flex_none().pl(14).pr(8).gap(7).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_click((_e, cx) => { this.wtMenu = ""; this.addWorktree(wt, machine, cx); cx.notify(); })
      .child(svg("mods/spaces-tree/git-branch.svg").size(12).flex_none()
        .text_color(space ? t.accent : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_family("JetBrains Mono")
        .text_color(space ? t.muted : t.foreground).child(label || "worktree"))
      .when(wt.locked, (el) => el.child(div().text_size(10.5).text_color(t.muted).child("locked")))
      .when(missing === true, (el) => el.child(this.githubBranchButton(group, { folder: wt.path, machine }, branch, github, t)))
      .when(!space, (el) => el.child(h_flex().h(16).px(4).flex_none().items_center().rounded(4)
        .bg(alpha(t.accent, "14")).border(1).border_color(alpha(t.accent, "4d"))
        .child(div().text_size(10.5).font_medium().text_color(t.accent).child("+ add"))));
  }

  // A click shows the agent; Alt+click (or the ⇄ on the row) puts it beside the one
  // showing now. A drag cannot: mods get no drag payload and no events outside their
  // block, so there is nothing to move with the pointer.
  clickAgent(agent, e) {
    // The Alt/⇄ gesture adds an agent to the wall; a plain click is asking for that agent's
    // own place, so a wall gives way to it first — even when the agent is already one of its
    // tiles and the focus alone would change nothing for the wall to notice.
    if (!e.modifiers.alt) {
      if (shared("agent-wall.on")) run("agent-wall.off");
      run("agent.focus", { terminal: agent.address });
      return;
    }
    setShared("agent-wall.pending", agent.address);
    run("agent-wall.pair");
  }

  // The last prompts each agent received, from its own store, asked at most every 10 s per
  // agent. Never blocks a render; a store that fails keeps what it had. A changed set of
  // prompts is also the signal that the thread's title may be out of date.
  refreshPrompts(cx) {
    const now = Date.now();
    // One pane lookup per refresh, not one per agent.
    const paneById = new Map();
    for (const p of panes()) if (!paneById.has(p.pane)) paneById.set(p.pane, p);
    for (const agent of agents()) {
      if (this.asking.has(agent.address) || !readable(agent.app)) continue;
      const seen = this.prompts[agent.address];
      if (seen && now - seen.at < 10000) continue;
      const cwd = paneById.get(agent.pane)?.cwd ?? null;
      this.asking.add(agent.address);
      cx.spawn(async (cx) => {
        let thread = this.threads[agent.address] ?? null;
        try { thread = await threadPrompts(agent, cwd, 8); } catch { /* keep the last one */ }
        const prompt = thread?.prompts[0] ?? "";
        this.prompts[agent.address] = { prompt, at: Date.now() };
        if (thread?.prompts.length) {
          this.threads[agent.address] = thread;
          this.considerTitle(agent, thread, cx);
        }
        this.asking.delete(agent.address);
        // An unchanged prompt is a fresh timestamp, not a reason to redraw the window.
        if (prompt !== (seen?.prompt ?? "")) this.redraw(cx);
      });
    }
  }

  // The title generated for an agent's thread, when one is ready.
  titleOf(address) {
    const titles = this.titlesNow ?? shared("thread-titles");
    const found = titles && typeof titles === "object" ? titles[address] : null;
    return found && typeof found.title === "string" ? found.title : "";
  }

  // Queue a title when the prompts changed. One generator call runs at a time: a title is a
  // background label, and a burst of prompts in several agents must not become a burst of
  // model requests. A newer prompt for an agent already waiting replaces its older job.
  considerTitle(agent, thread, cx) {
    const key = threadKey(thread);
    const titles = shared("thread-titles");
    const seen = titles && typeof titles === "object" ? titles[agent.address] : null;
    if (seen?.key === key) return;
    if (this.titleFailed[agent.address] === key) return;
    if (this.titleBusy === agent.address && this.titleBusyKey === key) return;
    const waiting = this.titleJobs.get(agent.address);
    if (waiting?.key === key) return;
    this.titleJobs.set(agent.address, { key, thread, at: Date.now() });
    this.pumpTitles(cx);
  }

  // Write the next queued title. The request is checked again at run time: the shared state or
  // the agent's prompts may have moved on while other titles were being written.
  pumpTitles(cx) {
    if (this.titleBusy || this.titleJobs.size === 0) return;
    const [address, job] = this.titleJobs.entries().next().value;
    this.titleJobs.delete(address);
    const agent = agents().find((a) => a.address === address);
    if (!agent) { this.pumpTitles(cx); return; }
    const titles = shared("thread-titles");
    const now = titles && typeof titles === "object" ? titles[address] : null;
    if (now?.key === job.key) { this.pumpTitles(cx); return; }
    this.titleBusy = address;
    this.titleBusyKey = job.key;
    cx.spawn(async (cx) => {
      let title = "";
      try {
        const pane = panes().find((p) => p.pane === agent.pane);
        title = await generateTitle({
          agentName: agent.program?.name || agent.app || "",
          folder: pane?.cwd ?? "",
          prompts: job.thread.prompts,
          recap: job.thread.recap ?? "",
          previous: now?.title ?? "",
        });
      } catch { title = ""; }
      this.titleBusy = null;
      this.titleBusyKey = "";
      if (title) {
        const all = { ...(shared("thread-titles") ?? {}) };
        const before = all[address];
        if (!before || before.title !== title || before.key !== job.key) {
          all[address] = { title, key: job.key, at: Date.now(), session: job.thread.session ?? "" };
          // A title nobody has refreshed in a month belongs to no live thread here.
          for (const [key, value] of Object.entries(all)) {
            if (key !== address && Date.now() - Number(value?.at ?? 0) > 30 * 24 * 3600 * 1000) delete all[key];
          }
          setShared("thread-titles", all);
        }
      } else {
        // Do not ask again for the same prompts on every poll; a new prompt tries again.
        this.titleFailed[address] = job.key;
      }
      // Prompts that landed while this title was written are still owed one.
      const latest = this.threads[address];
      const current = (shared("thread-titles") ?? {})[address];
      if (latest && threadKey(latest) !== (current?.key ?? "")) this.considerTitle(agent, latest, cx);
      cx.notify();
      this.pumpTitles(cx);
    });
  }

  // The subagents a terminal runs, as its own records name them: pi-subagents writes one per job
  // ("subagents/<run>", "subagents/<run>.task-1") as OSC 7501 records on the terminal it runs in.
  // `agents()` never carries them and `hc ls` does not print them, so this reads `hc get`, at most
  // every 5 s per agent and only on this computer (a remote one would pay an ssh round for it).
  // Never blocks a render; a read that fails keeps the records it had.
  refreshSubagents(cx) {
    const now = Date.now();
    const live = new Set(agents().map((agent) => agent.address));
    for (const address of Object.keys(this.subs)) if (!live.has(address)) delete this.subs[address];
    for (const agent of agents()) {
      if (String(agent.address).includes("/") || this.askingSubs.has(agent.address)) continue;
      const seen = this.subs[agent.address];
      // Nothing there twice in a row: poll it rarely instead of every tick. A read that fails
      // keeps the old list and does not count, so a temporarily broken `hc get` is retried soon.
      const wait = (seen?.misses ?? 0) >= 2 ? SUBS_IDLE_MS : 5000;
      if (seen && now - seen.at < wait) continue;
      const before = seen?.list ?? [];
      this.askingSubs.add(agent.address);
      cx.spawn(async (cx) => {
        let list = this.subs[agent.address]?.list ?? [];
        let misses = this.subs[agent.address]?.misses ?? 0;
        let ok = false;
        try {
          const got = await hc(["get", agent.address]);
          if (got.code === 0) {
            const records = JSON.parse(String(got.stdout ?? "{}"))?.records ?? {};
            list = Object.entries(records)
              .filter(([, record]) => record?.app === "pi-subagents")
              .map(([id, record]) => ({
                id,
                title: plain(record.title),
                state: String(record.state ?? ""),
                msg: plain(record.msg),
              }))
              .sort((a, b) => (STATE_RANK[a.state] ?? 9) - (STATE_RANK[b.state] ?? 9));
            ok = true;
          }
        } catch { /* keep the list it had */ }
        if (ok) misses = list.length ? 0 : misses + 1;
        this.subs[agent.address] = { list, at: Date.now(), misses };
        this.askingSubs.delete(agent.address);
        // A poll that found what it found last time must not redraw the window for it.
        const changed = list.length !== before.length
          || list.some((s, i) => s.id !== before[i].id || s.state !== before[i].state || s.title !== before[i].title || s.msg !== before[i].msg);
        if (changed) this.redraw(cx);
      });
    }
  }

  // What those records mean for the row and the card. A workflow's own record aggregates the
  // tasks listed under it, so counting both would say three working when two reviewers run: a
  // run whose tasks are listed is not counted again.
  subagentsOf(address) {
    const list = this.subs?.[address]?.list ?? [];
    const runs = new Set(list.filter((s) => s.id.includes(".")).map((s) => s.id.slice(0, s.id.lastIndexOf("."))));
    const counted = list.filter((s) => !runs.has(s.id));
    const active = counted.filter((s) => s.state === "working" || s.state === "blocked");
    const blocked = active.some((s) => s.state === "blocked");
    return { counted, active, state: !active.length ? "" : blocked ? "blocked" : "working" };
  }

  // A row's card under the pointer: opened once the pointer rests on the row, so running down
  // the list does not flash one card per row, and kept while the pointer is on the card itself.
  hoverAgent(agent, on, cx) {
    const address = agent.address;
    if (on) {
      this.hoverRow = address;
      this.holdCard = false;
      if (this.card === address) return;
      cx.timer.after(260, (cx) => {
        if (this.hoverRow !== address || this.card === address) return;
        this.card = address;
        this.loadModel(agent, cx);
        cx.notify();
      });
      return;
    }
    if (this.hoverRow === address) this.hoverRow = "";
    // The pointer crossing the gap to the card must not close it: the card says it is held.
    cx.timer.after(200, (cx) => {
      if (this.card === address && !this.holdCard) { this.card = ""; cx.notify(); }
    });
  }

  // The model this agent's footer names, read when its card opens and kept for a moment: the
  // screen is the only place it is said, and reading it costs one `hc read`.
  loadModel(agent, cx) {
    const seen = this.models?.[agent.address];
    if (seen && Date.now() - seen.at < 15000) return;
    // Two hovers landing inside one read must not spawn it twice.
    this.askingModel ??= new Set();
    if (this.askingModel.has(agent.address)) return;
    this.askingModel.add(agent.address);
    cx.spawn(async (cx) => {
      let text = "";
      try { text = await lastModel(agent); } catch { text = ""; }
      this.models[agent.address] = { text, at: Date.now() };
      this.askingModel.delete(agent.address);
      cx.notify();
    });
  }

  // What a row says in full under the pointer: which agent, how it is doing, the model and
  // effort its own footer names, where it sits, and the whole of what it was last asked — the
  // row itself has room for a few words of that. Built in this render, so a scan, a prompt and
  // a model read reach an open card as they change.
  agentCard(agent, t) {
    const program = agent.program ?? {};
    const status = agent.status ?? "idle";
    const busy = status === "working" || status === "blocked";
    // What pulses: an agent that is working, not one that is blocked (blocked is waiting on a
    // person, and a pulse there would read as progress).
    const working = status === "working";
    const color = status === "idle" ? t.muted : (t[status] ?? t.dim);
    // The header chip is the aggregate: a workflow's reviewers count as work even though the
    // parent's own turn is over. The section below says which state is the parent's own.
    const subs = this.subagentsOf(agent.address);
    const chipState = subs.state || status;
    const chipBusy = chipState === "working" || chipState === "blocked";
    const chipInk = stateInk(chipState, t);
    const chipText = subs.state ? `${subs.active.length} ${chipState.toUpperCase()}` : status.toUpperCase();
    const name = nameOf(agent);
    const tile = program.tint ? program.tile : null;
    const ink = program.color || (tile ? "#ffffff" : t.foreground);
    const brand = tile ?? t.accent;
    const pane = panes().find((p) => p.pane === agent.pane) ?? null;
    const said = this.prompts?.[agent.address]?.prompt ?? "";
    const title = this.titleOf(agent.address) || nativeTitle(agent);
    const [model, effort] = (this.models?.[agent.address]?.text ?? "").split(" \u00b7 ");
    // The family the model's name belongs to, and which of its words is the family rather than
    // the version: the card draws the provider's mark first and the name after it.
    const mark = brandOf(model);
    const familyInk = (mark && readOn(mark.color, settings().dark)) || t.foreground;
    const [family, version] = splitModel(model);
    const tab = agent.tab_name || (agent.tab_index != null ? String(agent.tab_index + 1) : "");
    const where = [agent.space_name, tab].map((part) => plain(part)).filter(Boolean).join(" \u00b7 ");
    const cwd = pane?.cwd ? plain(String(pane.cwd).replace(home(), "~")) : "";
    const branch = pane?.branch ? plain(pane.branch) : "";
    // Inter for words — a UI sans that stays readable at 10px on a dark card — and JetBrains
    // Mono only where the text is an address, a path, a branch or a model id. Inter ships in
    // this mod's fonts/ folder, so the card reads the same on a machine that has neither.
    const mono = "JetBrains Mono";
    const ui = "Inter";
    const rule = alpha(t.foreground, "12");
    const label = (text) => div().flex_none().font_family(ui).text_size(10.5).font_semibold()
      .text_color(alpha(t.foreground, "66")).child(text);
    const level = EFFORT_LEVEL[String(effort ?? "").toLowerCase()] ?? 0;
    // A balloon rather than a panel: the outline is ink-heavy, and agentRow hangs it off the row
    // it came from by a tail, so the card reads as that row's speech.
    const outline = alpha(t.foreground, "3d");
    return v_flex().id(`card-${agent.address}`).w(432).rounded(14).bg(t.popover)
      .border_2().border_color(outline).shadow_lg().overflow_hidden().cursor_pointer().relative()
      .on_click((e, cx) => { this.clickAgent(agent, e); this.card = ""; cx.notify(); })
      // The card's air: a sheen from its top-left corner to its bottom-right one and a dot grid
      // down its right side, both drawn behind every section rather than only behind the header.
      // Both fill the card's own box (the sheen stretches to it, so it reaches the last section
      // however long the asked text makes the card; the dots run past the bottom and are cut by
      // the corners). A working agent breathes light across the whole card.
      .child(div().absolute().top(0).bottom(0).left(0).right(0)
        .child(svg("mods/spaces-tree/sheen.svg").size_full().text_color(brand).opacity(SHEEN_INK)))
      .child(div().absolute().top(-18).right(-24).w(170).h(900)
        .child(svg("mods/spaces-tree/dots.svg").w(170).h(900).text_color(brand).opacity(0.16)))
      // A breath of light over the whole card: it is alive even when the agent has nothing to
      // report. It fills the card's own box edge to edge, so it is clipped by the corner radius
      // rather than ending inside it (a moving band would need `loop` on `left`, which this
      // build does not animate).
      .child(div().absolute().top(0).bottom(0).left(0).right(0)
        .loop("opacity", { from: 0.25, to: 1, period: 2800 })
        .child(svg("mods/spaces-tree/shine.svg").size_full().text_color(t.foreground).opacity(0.08)))
      // The header carries the agent's colour itself (tinted, rounded with the card) rather than
      // a strip along the top edge, which cannot follow the card's corners.
      .child(v_flex().p(15).pb(13).gap(11).rounded_t(14)
        .child(h_flex().gap(12).items_center()
          // Motion that means something, and only what it means: a working agent's own mark
          // pulses, and so do the model it runs and the share of its thinking it is spending —
          // three parts of one pulse, at one period, in step. Nothing spins: a ring going round
          // reads as work getting somewhere whether or not it is. Blocked does not pulse at all;
          // a person is what is missing, so light breathes out from behind the tile instead.
          .child(div().size(56).flex_none().flex().items_center().justify_center().relative()
            .when(status === "blocked", (el) => el
              .child(div().absolute().left(-14).top(-14).size(84)
                .loop("opacity", { from: 0.35, to: 1, period: 1700 })
                .child(svg("mods/spaces-tree/blocked-glow.svg").size(84).text_color(color).opacity(0.75)))
              .child(div().absolute().left(-6).top(-6).size(68)
                .loop("opacity", { from: 0.16, to: 0.6, period: 2800 })
                .child(svg("mods/spaces-tree/halo-ring.svg").size(68).text_color(color)))
              .child(div().absolute().left(2).top(2).size(52)
                .loop("opacity", { from: 0.35, to: 1, period: 1700 })
                .child(svg("mods/spaces-tree/halo-ring.svg").size(52).text_color(color))))
            // A soft bloom of the agent's own colour behind the mark: it swells and fades with
            // the pulse, so the logo seems to glow rather than simply grow. It is one more layer
            // in the same 56px box, drawn before the tile so it sits behind it.
            .when(working, (el) => el.child(div().absolute().left(0).top(0)
              .loop("left", { from: 4, to: -6, period: PULSE_MS })
              .loop("top", { from: 4, to: -6, period: PULSE_MS })
              .loop("width", { from: 48, to: 68, period: PULSE_MS })
              .loop("height", { from: 48, to: 68, period: PULSE_MS })
              .loop("opacity", { from: 0.22, to: 0.7, period: PULSE_MS })
              .child(svg("mods/spaces-tree/blocked-glow.svg").size_full().text_color(color))))
            // The tile and the mark inside it swell and settle together: the logo itself
            // breathes, rather than a ring breathing around a logo that stands still. The tile
            // lives in a 56px box that does not move, so nothing else on the card shifts.
            .child(this.swell(h_flex().size(44).rounded(12).items_center().justify_center()
              .when(working, (el) => el.loop("opacity", { from: 0.62, to: 1, period: PULSE_MS }))
              .bg(tile ?? alpha(color, "1c"))
              .border_1().border_color(tile ? alpha(t.foreground, "26") : alpha(color, "55")), working, 38, 48)
              .when(Boolean(program.icon), (el) => el.child(program.tint
                ? this.swell(svg(program.icon).size(21), working, 18, 25).text_color(ink)
                : this.swell(image(program.icon).w(24).h(24), working, 19, 27)))
              .when(!program.icon, (el) => el.child(div().font_family(ui).text_size(15).font_semibold()
                .text_color(ink).child(INITIALS(name))))))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(7).items_center()
              .child(div().min_w(0).truncate().font_family(ui).text_size(19).font_semibold()
                .text_color(t.foreground).child(title || name))
              .when(agent.pinned, (el) => el.child(div().flex_none().font_family(ui).text_size(10.5)
                .font_semibold().text_color(t.accent).child("PINNED"))))
            .child(h_flex().gap(5).items_center()
              .child(svg("mods/spaces-tree/house.svg").size(10).flex_none().text_color(t.dim))
              .child(div().min_w(0).truncate().font_family(ui).text_size(12.5)
                .text_color(t.muted).child(where))))
          .child(h_flex().h(21).px(8).gap(6).flex_none().items_center().rounded(11)
            .bg(alpha(chipInk, "26")).border_1().border_color(alpha(chipInk, "73"))
            .child(div().size(6).flex_none().rounded(3).bg(chipInk)
              .when(chipBusy, (el) => el.loop("opacity", { from: 0.25, to: 1, period: 900 })))
            .child(div().font_family(ui).text_size(11).font_semibold().text_color(chipInk)
              .child(chipText)))))
      // The subagents this terminal runs, when its own records name any: the chip counts them,
      // and this says which is which. The parent's own turn is the caption, so an idle parent
      // with reviewers working reads as exactly that.
      .when(subs.counted.length > 0, (el) => el.child(v_flex().px(15).py(11).gap(7)
        .border_t(1).border_color(rule)
        .child(h_flex().gap(6).items_center()
          .child(label("SUBAGENTS"))
          .child(div().flex_1())
          .child(div().font_family(ui).text_size(10.5).text_color(t.muted)
            .child(`parent ${status}`)))
        .children(subs.counted.slice(0, 6).map((sub) => {
          const ink = stateInk(sub.state, t);
          return h_flex().gap(7).items_center()
            .child(div().size(5).flex_none().rounded(3).bg(ink))
            .child(div().flex_none().font_family(mono).text_size(11.5).text_color(t.foreground)
              .child(sub.title))
            .child(div().flex_1().min_w(0).truncate().font_family(ui).text_size(11.5)
              .text_color(t.muted).child(sub.msg))
            .child(div().flex_none().font_family(ui).text_size(10).font_semibold()
              .text_color(ink).child(sub.state));
        }))
        .when(subs.counted.length > 6, (x) => x.child(div().font_family(ui).text_size(10.5)
          .text_color(t.muted).child(`+${subs.counted.length - 6} more`)))))
      // The model the agent names on its own screen, drawn before it is named: the provider's
      // mark in white on the provider's own colour, the family's word in that colour, the
      // version in the card's quiet text, and the effort as a small cake at the row's end.
      // The card is where two agents are compared, so the model reads at a glance, not by parsing.
      .when(Boolean(model), (el) => el.child(v_flex().px(15).pt(9).pb(10).gap(7)
        .border_t(1).border_color(alpha(t.foreground, "12"))
        .child(h_flex().gap(9).items_center()
          // The provider's tile. A model nothing claims keeps the name's own initials on a plain
          // tile: the card never draws a logo the name did not earn.
          // The provider's tile, still: only the agent's own mark moves. A working card animates
          // one thing, the agent, and the model it runs is read, not watched.
          .child(h_flex().size(24).flex_none().rounded(7).items_center().justify_center()
            .bg(mark ? mark.color : alpha(t.foreground, "12"))
            .border_1().border_color(mark ? alpha(inkOn(mark.color), "2e") : alpha(t.foreground, "1f"))
            .when(Boolean(mark), (x) => x.child(svg(mark.icon).size(14).flex_none()
              .text_color(inkOn(mark.color))))
            .when(!mark, (x) => x.child(div().font_family(ui).text_size(11).font_semibold()
              .text_color(t.muted).child(INITIALS(model)))))
          .child(h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(h_flex().min_w(0).gap(5).items_center()
              .child(div().flex_none().font_family(ui).text_size(13.5).font_semibold()
                .text_color(familyInk).child(family))
              .when(Boolean(version), (x) => x.child(div().min_w(0).truncate()
                .font_family(mono).text_size(13).text_color(t.muted).child(version))))
            .child(div().flex_1())
            .when(Boolean(effort), (x) => x.child(this.effortCake(level, familyInk)))
            .when(Boolean(effort), (x) => x.child(div().flex_none().font_family(ui).text_size(11.5)
              .font_semibold().text_color(familyInk).child(effort.toUpperCase())))))))
      // What it was asked, in full: the row above has room for a few words of it.
      .when(Boolean(said), (el) => el.child(v_flex().px(15).py(12).gap(7)
        .border_t(1).border_color(rule)
        .child(h_flex().gap(6).items_center()
          .child(svg("mods/spaces-tree/quote.svg").size(10).flex_none().text_color(brand))
          .child(label("ASKED")))
        .child(h_flex().gap(9)
          .child(div().w(2).flex_none().rounded(1).bg(alpha(brand, "cc")))
          .child(div().flex_1().min_w(0).max_h(230).overflow_y_scrollbar()
            .font_family(ui).text_size(13).line_height(1.55).text_color(t.foreground).child(said)))))
      // Where it is: the terminal's own address, its folder, its branch.
      .child(h_flex().px(15).py(9).gap(12).items_center().border_t(1).border_color(rule)
        .bg(alpha(t.foreground, "04"))
        .child(h_flex().gap(4).items_center().flex_none()
          .child(svg("mods/spaces-tree/terminal.svg").size(10).flex_none().text_color(t.dim))
          .child(div().font_family(mono).text_size(11).text_color(t.muted)
            .child(agent.address.replace(/[^\x20-\x7e]/g, ""))))
        .when(Boolean(cwd), (x) => x.child(h_flex().min_w(0).gap(4).items_center()
          .child(svg("mods/spaces-tree/folder.svg").size(10).flex_none().text_color(t.dim))
          .child(div().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.muted).child(cwd))))
        .when(Boolean(branch), (x) => x.child(h_flex().gap(4).items_center().flex_none()
          .child(svg("mods/spaces-tree/git-branch.svg").size(10).flex_none().text_color(t.dim))
          .child(div().font_family(mono).text_size(11).text_color(t.muted).child(branch))))
        .child(div().flex_1())
        .child(div().flex_none().font_family(ui).text_size(10.5).text_color(t.muted)
          .child("alt+click \u00b7 \u21c4 pair")))
  }

  // The agents the wall is showing: its own tiles, read from the layout on screen. Nothing
  // else marks a row — a remembered set (what the chip would open next, or the frozen active
  // list) must not light up an agent the person cannot see, and an active wall marks only
  // the ones it froze, not every agent in the panel.
  wallShown() {
    if (shared("layout") !== WALL_LAYOUT) return null;
    const shown = new Set();
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      const id = String(node.id ?? "");
      if (id.startsWith(WALL_TILE)) shown.add(id.slice(WALL_TILE.length));
      for (const child of node.children ?? []) walk(child);
      for (const child of node.floating ?? []) walk(child);
    };
    walk(layout());
    return shown.size ? shown : null;
  }

  agentRow(agent, t) {
    const program = agent.program ?? {};
    const status = agent.status ?? "idle";
    const color = status === "idle" ? t.muted : (t[status] ?? t.dim);
    // Any subagent still working outranks the parent's own turn: pi says idle as soon as it
    // hands a workflow over, and that is exactly when the reviewers run.
    const subs = this.subagentsOf(agent.address);
    const state = subs.state || status;
    const chipInk = stateInk(state, t);
    const chipText = subs.state ? `${subs.active.length} ${state}` : status;
    const name = nameOf(agent);
    const prompt = this.prompts[agent.address]?.prompt ?? "";
    const said = prompt && prompt !== name ? prompt : "";
    // The logo already says which agent this is, so the row names the work: the generated (or
    // terminal's own) title, then the last thing the person asked. A thread with no title yet
    // leads with that prompt instead; the name is only a last resort.
    const title = this.titleOf(agent.address) || nativeTitle(agent);
    const headline = title || said || plain(agent.tab_name || agent.address || name);
    const sub = title && said ? said : "";
    const onWall = Boolean(this.wall?.has(agent.address));
    const lit = agent.focused || onWall;
    // The program's own tile and glyph color when it has one: the row is recognized by the
    // agent's mark, not by a grey box that every agent shares.
    const tile = program.tint ? program.tile : null;
    const ink = program.color || (tile ? "#ffffff" : t.foreground);
    // The row's tooltip became the card, prompt and pairing included: two surfaces over one
    // row would fight for the pointer.
    const row = h_flex().id(`a-${agent.address}`).h(sub ? 38 : 30).flex_none().pl(10).pr(8).gap(8).items_center()
      .border_l(2).border_color(lit ? t.accent : alpha(t.accent, "00"))
      .rounded(7).cursor_pointer()
      .when(agent.focused, (el) => el.bg(alpha(t.accent, "1c")))
      .when(onWall && !agent.focused, (el) => el.bg(alpha(t.accent, "0f")))
      .hover((s) => s.bg(t.hover))
      .on_click((e) => this.clickAgent(agent, e))
      .on_mouse_down("right", () => this.paneMenu(agent))
      .child(h_flex().size(22).flex_none().rounded(7).items_center().justify_center()
        .bg(tile ?? alpha(color, "14"))
        .when(!tile, (el) => el.border(1).border_color(alpha(color, "3d")))
        .when(Boolean(program.icon), (el) => el.child(program.tint
          ? svg(program.icon).size(12).text_color(ink)
          : image(program.icon).w(14).h(14)))
        .when(!program.icon, (el) => el.child(div().text_size(10.5).font_semibold().text_color(ink)
          .child(INITIALS(name)))))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(13).font_medium()
          .text_color(lit ? t.foreground : t.muted).child(headline))
        .when(Boolean(sub), (el) => el.child(h_flex().min_w(0).gap(3).items_center()
          .child(div().flex_none().text_size(10.5).text_color(t.accent).child("\u276f"))
          .child(div().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(sub)))))
      .when(agent.pinned, (el) => el.child(h_flex().h(17).px(5).flex_none().items_center().rounded(5)
        .bg(t.raised).child(div().text_size(11).text_color(t.muted).child("pinned"))))
      .child(h_flex().id(`pair-${agent.address}`).size(18).flex_none().items_center().justify_center().rounded(5)
        .text_size(12).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(alpha(t.accent, "22")).text_color(t.accent))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => { setShared("agent-wall.pending", agent.address); run("agent-wall.pair"); })
        .child("\u21c4"))
      // Live states keep a tinted tag; idle is the default and stays quiet. A row with
      // subagents working says how many, in their colour, not the parent's idle.
      .child(h_flex().h(17).px(5).gap(3).items_center().rounded(8).flex_none()
        .when(state !== "idle", (el) => el.bg(alpha(chipInk, "16")).border(1).border_color(alpha(chipInk, "33")))
        .child(div().size(5).flex_none().rounded(3).bg(chipInk))
        .child(div().text_size(11).font_medium().text_color(chipInk).child(chipText)));
    // The card is anchored in its own layer, right of the row, and only the row under the
    // pointer builds one; hovering the card keeps it (hoverAgent sees the card's own hover).
    const open = this.card === agent.address;
    // Anchors pin a corner of the card to the row, so the card would grow over the list; the
    // spacer under it carries the card past the panel's right edge, clear of the rows.
    return Popup.new(`row-${agent.address}`, row.on_hover((on, cx) => {
      this.hoverAgent(agent, on, cx);
      this.hot(`a-${agent.address}`, on, cx);
    }))
      .anchor("left_center")
      .when(open, (el) => el.content(this.balloonCard(agent, t).on_hover((on, cx) => {
        this.holdCard = on;
        if (!on) this.hoverAgent(agent, false, cx);
      })));
  }

  // Swelling marks: a working agent's logo (and the model's) grows and settles. Only when it is
  // working — a still card says the agent is idle at a glance. Width and height animate together,
  // inside a box that does not, so the growth cannot shift anything on the card.
  swell(element, working, from, to) {
    if (!working) return element;
    return element
      .loop("width", { from, to, period: PULSE_MS })
      .loop("height", { from, to, period: PULSE_MS });
  }

  // The thinking level as a small cake: a ring for the scale, an arc for the share of it the
  // agent's own footer names, and a wide, faint copy of that arc as its glow. It breathes — faster
  // and deeper while the agent works — so the gauge is alive at a glance; the four bars it
  // replaces read as a progress line, and a cake is the same fact with a shape. `none` is a dot.
  effortCake(level, ink) {
    const step = Math.max(0, Math.min(4, Math.round(level)));
    // Only the agent's own mark moves on this card, so the gauge holds its level still: the
    // number is meant to be read at a glance, not to flicker while it is read.
    return div().relative().size(18).flex_none()
      .child(svg("mods/spaces-tree/effort-track.svg").absolute().left(0).top(0).size(18)
        .text_color(alpha(ink, "2e")))
      .child(div().absolute().left(0).top(0).size(18)
        .child(svg(`mods/spaces-tree/effort-${step}.svg`).size(18).text_color(ink)));
  }

  // The card as a balloon: it is set back 26px from the row, and one big tail in that gap
  // points back at its own row. The tail is drawn after the card, on the card's own edge: its
  // fill closes the border between its two curves, so the card's outline runs into the tail
  // instead of a line standing between them, and its outline is a stroke on those curves alone
  // — nothing is drawn across the mouth. The fill is the card's own light, not its base colour:
  // the sheet runs edge to edge, so a tail of plain `popover` would read as a hole cut in it.
  // It breathes with the sheen it is filled from, from the same frame and at the same period,
  // so the mouth never shows a seam of two lights out of step. The tail sits inside the
  // content's own box, so nothing is drawn outside what the popup lays out.
  balloonCard(agent, t) {
    const edge = alpha(t.foreground, "3d");
    const brand = (agent.program?.tint ? agent.program.tile : null) ?? t.accent;
    // The card is one wash of the agent's colour over `popover` (sheen.svg, SHEEN_INK). At its
    // left edge, where the tail joins, that wash is about a tenth of the colour: the tail is
    // filled with exactly that, so the two are the same light and no seam shows. It does not
    // breathe — a light that animates on both sides drifts out of step and the mouth shows it.
    return h_flex().relative().pl(16)
      .child(this.agentCard(agent, t))
      .child(div().absolute().left(0).top(0).bottom(0).w(18).flex().items_center()
        .child(div().relative().w(18).h(28).cursor_pointer()
          .on_click((e, cx) => { this.clickAgent(agent, e); this.card = ""; cx.notify(); })
          .child(svg("mods/spaces-tree/tail-inner.svg").absolute().left(0).top(0).w(18).h(28)
            .text_color(t.popover))
          .child(svg("mods/spaces-tree/tail-inner.svg").absolute().left(0).top(0).w(18).h(28)
            .text_color(brand).opacity(TAIL_INK))
          .child(svg("mods/spaces-tree/tail.svg").absolute().left(0).top(0).w(18).h(28)
            .text_color(edge))));
  }

  // A chip that opens the list of choices it stands for.
  picker(t, id, label, open) {
    return h_flex().id(`sp-${id}`).h(22).px(6).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
      .bg(open ? t.selected : t.raised)
      .border(1).border_color(open ? t.accent : t.border)
      .hover((s) => s.bg(t.hover))
      .tooltip(id === "sort" ? "Sort the tree" : "Show only agents in one state")
      .on_click((_e, cx) => { this.menu = this.menu === id ? "" : id; cx.notify(); })
      .child(div().text_size(12).text_color(open ? t.foreground : t.muted).child(label))
      .child(svg("mods/spaces-tree/chevron-down.svg").size(9).text_color(open ? t.accent : t.muted));
  }

  // The choices, in a row of their own: the active one marked, a click picks it.
  options(t, id, choices, current) {
    return h_flex().flex_none().px(10).py(4).gap(4).border_b(1).border_color(t.border)
      .children(choices.map(([value, label]) => h_flex().id(`sp-${id}-${value}`).h(22).px(7).flex_none()
        .items_center().rounded(5).cursor_pointer().text_size(11.5)
        .bg(value === current ? alpha(t.accent, "22") : t.raised)
        .text_color(value === current ? t.accent : t.muted)
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (id === "sort") setShared("spaces-tree.sort", value);
          else setShared("spaces-tree.only", value);
          this.menu = "";
          cx.notify();
        })
        .child(label)));
  }

  // A repo and, when it is unfolded, its branches and their agents under one rail: a single
  // line says what belongs to the repo, and the agents' extra indent says where they hang.
  groupBlock(group, t) {
    const open = !this.closed.has(group.key);
    // A repo is one row and the cards of its spaces under it. A space with no repo is a group of
    // its own, not a branch of anything: it keeps the row the panel gives every group head, and
    // its agents hang off the rail under it — no perimeter, since there is no repo rail above it
    // for a card to stand in for, and a second box at the section's indent would read as a
    // section of its own beside the NO REPO heading.
    return v_flex().flex_none().gap(1)
      .child(this.groupRow(group, t))
      .when(open, (el) => el.child(this.groupBody(group, t)));
  }

  // A space as one box: its line and the agents it owns, closed on four sides, so the panel says
  // where a space begins and ends and a space's agents cannot read as the next space's.
  //
  // The perimeter is drawn in every state and only changes colour — the reserve `agent-wall` and
  // `tabs-gh` keep on their chips — so a label, a chip or a row never moves because a space was
  // hovered or shown, and it is the panel's own hairline while the space is quiet — the chrome
  // nudged a few steps toward the border, so a quiet space reads as one box against the panel
  // without the line itself being noticed. It also takes the 2px the old left bar took (see
  // placeRow), so nothing under it moved either.
  spaceCard(t, { head, body = null, active = false, kept = false, pointed = false }) {
    const edge = active ? t.accent : kept ? fade(t.border, "14") : fade(t.border, "0a");
    return v_flex().flex_none().min_w(0).gap(1).rounded(7).border(1).border_color(edge)
      .when(Boolean(body), (el) => el.pb(2))
      .when(active, (el) => el.bg(t.selected))
      // The box answers the pointer, not just its line: pointing at an agent row says which space
      // that agent belongs to.
      .when(pointed, (el) => el.bg(active ? t.selected : t.hover).border_color(active ? t.accent : t.input))
      .child(head)
      .when(Boolean(body), (el) => el.child(body));
  }

  // The boxes of a repo's spaces, and the plain rows of everything else. A repo's boxes start in
  // the column the rail ran in, so their left edges stand in for it, and each box's own left edge
  // is the spine its agents hang off. A space with no repo has no box: its agents hang off the
  // rail under its row, exactly as they always have.
  groupBody(group, t) {
    const rail = alpha(t.border, "80");
    const first = group.places.find((p) => p.space)?.space ?? null;
    const boxed = Boolean(group.repo);
    return v_flex().flex_none().ml(17)
      // 3px between two boxes: two reserved perimeters 1px apart would fuse into one 2px seam.
      .when(boxed, (el) => el.gap(3))
      .when(!boxed, (el) => el.gap(1).border_l(1).border_color(rail))
      .children(group.places.map((place) => {
        const bare = !group.repo || (!place.at.id && !place.at.worktree);
        const shut = Boolean(place.space) && this.closed.has(`space:${place.space.id}`);
        // A folded space keeps its box and loses its agents: the box closes right under the line
        // instead of standing open over rows that are not drawn.
        const agents = !shut && place.agents.length > 0
          ? v_flex().flex_none().ml(17).gap(1).children(place.agents.map((agent) => this.agentRow(agent, t)))
          : null;
        // One indent in, the same step a repo's agents take past their line.
        if (bare) return agents;
        const boxKey = place.space?.id ?? place.kept?.id ?? `main-${place.at.id || place.at.repo}`;
        return this.spaceCard(t, {
          active: Boolean(place.space?.active),
          kept: Boolean(place.kept),
          pointed: this.pointsAt(`s-${boxKey}`, ...place.agents.map((agent) => `a-${agent.address}`)),
          head: this.placeRow(group, place, t, first),
          body: agents,
        });
      }).filter(Boolean));
  }

  render() {
    const t = theme();
    // One read of the titles map for the whole frame: every row and card looks up the same copy.
    this.titlesNow = shared("thread-titles") ?? {};
    const prefs = this.prefs();
    const { sort, only } = prefs;
    const groups = this.tree(prefs);
    this.wall = this.wallShown();
    // `alt+↑/↓` walks the rows in the order this panel draws them, not in Herdr's own. The
    // order is handed over only when it changed: a render of the same tree is not a new order.
    const order = groups.flatMap((group) => group.places.flatMap((place) => place.agents.map((agent) => agent.address)));
    const orderKey = order.join("\u0000");
    if (orderKey !== this.orderKey) {
      this.orderKey = orderKey;
      setAgentOrder(order);
    }
    const total = agents().length;
    const shown = groups.reduce((n, group) => n + group.agents.length, 0);
    const filtering = only !== "all" || String(this.query ?? "").trim() !== "";
    const root = reposRoot().replace(home(), "~");
    return v_flex().id("spaces-tree-root").size_full().min_h(0).bg(t.chrome)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center()
        .child(div().text_size(12.5).font_semibold().text_color(t.muted).child("SPACES"))
        .child(div().flex_1())
        .child(h_flex().h(20).px(6).flex_none().items_center().rounded(6).bg(t.raised)
          .tooltip(`${total} ${total === 1 ? "agent" : "agents"} in ${groups.length} ${groups.length === 1 ? "group" : "groups"}${filtering ? `, ${shown} shown` : ""}`)
          .child(div().text_size(12).text_color(t.muted).child(filtering ? `${shown}/${total}` : String(total))))
        .child(h_flex().id("spaces-tree-add").h(22).pl(5).pr(7).gap(4).flex_none().items_center().rounded(6).cursor_pointer()
          .bg(alpha(t.accent, "14")).border(1).border_color(alpha(t.accent, "4d"))
          .hover((s) => s.bg(alpha(t.accent, "2e")).border_color(t.accent))
          .tooltip(`New space: asks its name, and whether to make its repo folder in ${root}`)
          .on_click(() => this.addSpace())
          .child(svg("mods/spaces-tree/plus.svg").size(11).text_color(t.accent))
          .child(div().text_size(12.5).font_medium().text_color(t.accent).child("Space"))))
      .child(h_flex().h(36).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .child(h_flex().h(24).flex_1().min_w(0).px(7).gap(5).items_center().rounded(7)
          .bg(t.surface).border(1).border_color(this.focused ? t.accent : t.border)
          .child(svg("mods/spaces-tree/search.svg").size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.input).flex_1().min_w(0).h(22).text_size(13).text_color(t.foreground)))
        .child(this.picker(t, "sort", SORTS.find(([id]) => id === sort)[1], this.menu === "sort"))
        .child(this.picker(t, "only", only === "all" ? "all" : only, this.menu === "only")))
      .when(this.menu === "sort", (el) => el.child(this.options(t, "sort", SORTS, sort)))
      .when(this.menu === "only", (el) => el.child(this.options(t, "only", ONLY, only)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().py(6).pr(10).gap(5)
        .when(groups.length === 0, (el) => el.child(v_flex().p(16).gap(5).items_center()
          .child(svg("mods/spaces-tree/search.svg").size(18).text_color(t.dim))
          .child(div().text_size(12.5).text_color(t.muted).child(filtering ? "Nothing matches the filter" : "No spaces yet"))
          .when(filtering, (x) => x.child(div().id("sp-clear").text_size(12).text_color(t.accent).cursor_pointer()
            .on_click((_e, cx) => { this.input.set_value(""); this.query = ""; setShared("spaces-tree.only", "all"); this.menu = ""; cx.notify(); })
            .child("Clear the filter")))))
        .children(this.sections(groups, t)));
  }

  // Two lists, not one: the repos first, then the spaces that are no repo at all. A space made
  // in a folder git knows nothing of is a different kind of thing from a branch of a repo, and
  // putting the two kinds in one run of rows made the plain spaces read as repos without a mark.
  sections(groups, t) {
    const repos = groups.filter((group) => group.repo);
    const loose = groups.filter((group) => !group.repo);
    const out = [];
    if (repos.length > 0) out.push(...this.section("repos", "REPOS", repos, t,
      `${repos.length} ${repos.length === 1 ? "repo" : "repos"}`));
    if (loose.length > 0) out.push(...this.section("norepo", "NO REPO", loose, t,
      `${loose.length} ${loose.length === 1 ? "space" : "spaces"} whose folder is not a repo`));
    return out;
  }

  // A list under its own label, foldable like a repo: the label is a heading, so the rows keep
  // the panel's own indent rather than gaining one for being grouped.
  section(key, label, list, t, what) {
    const open = !this.closed.has(`section:${key}`);
    const head = h_flex().id(`sec-${key}`).h(26).flex_none().px(8).gap(6).items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover))
      .tooltip(`${what}${open ? "" : " — folded, click to open"}`)
      .on_click((_e, cx) => this.toggle(`section:${key}`, cx))
      .child(svg(`mods/spaces-tree/${open ? "chevron-down" : "chevron-right"}.svg`).size(11).flex_none()
        .text_color(t.muted))
      .child(div().text_size(12).font_semibold().text_color(t.muted).child(label))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.muted).child(String(list.length)));
    if (!open) return [head];
    return [head, ...list.flatMap((group, index) =>
      index === list.length - 1
        ? [this.groupBlock(group, t)]
        : [this.groupBlock(group, t), div().h(1).flex_none().mx(8).bg(t.border)])];
  }
}



