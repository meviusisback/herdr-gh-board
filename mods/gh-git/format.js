// Pure helpers shared by the two files of the git panel (main.js and issues.js): colours,
// display text, relative times, the commit-log parsers and the worktree naming rules. No
// gpui-kit or herdr import, so every function here can be tested on its own (format.test.js).

// #rrggbb + alpha, so a lane or item colour can be a line, a halo or a pill without a second table.
export const tint = (color, alpha) => (/^#[0-9a-f]{6}$/i.test(String(color ?? "")) ? `${color}${alpha}` : color);

export const initials = (name) => String(name ?? "").split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2)
  .map((word) => word[0]).join("").toUpperCase() || "?";

// Commit text, worktree names and the strings a card prints are untrusted: no control or bidi
// codepoints, so a name cannot reorder what a panel shows.
export const text = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

// One set of thresholds for both times a panel shows: a commit's epoch and an item's ISO date.
function relativeMs(ms) {
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d`;
  if (s < 31536000) return `${Math.floor(s / 2592000)}mo`;
  return `${Math.floor(s / 31536000)}y`;
}

export const relativeEpoch = (epoch) => relativeMs(Number(epoch) * 1000);
export const relativeIso = (iso) => relativeMs(Date.parse(iso));

// A commit subject as its convention reads it: `type(scope): what it does`. The type keeps
// its own colour, so a history is scanned by kind before a word is read.
export const splitSubject = (subject) => {
  const found = /^([a-z]+)(\([^)]*\))?:\s*/i.exec(subject);
  if (!found) return null;
  return { type: found[1].toLowerCase(), scope: found[2] ?? "", text: subject.slice(found[0].length) };
};

// What this view is reading: the machine matters, two folders can share a path.
export const atKey = ({ folder, on }) => (folder ? `${on ?? ""}|${folder}` : "");

// Flat log, one record per commit: hash, parents, author, epoch, refs, subject.
export function parseLog(out) {
  const commits = [];
  for (const record of String(out || "").split("\x1e")) {
    const line = record.startsWith("\n") ? record.slice(1) : record;
    if (!line.trim()) continue;
    const fields = line.split("\x1f");
    if (fields.length < 6) continue;
    const [hash, parents, author, epoch, refs, subject] = fields;
    // A subject may contain the field separators (git allows any byte in a message): only a
    // record whose hash really is a hash is a commit. A forged one would reach wl-copy.
    if (!/^[0-9a-f]{7,64}$/.test(String(hash).trim())) continue;
    commits.push({
      hash: text(hash),
      parents: String(parents || "").trim().split(/\s+/).filter(Boolean),
      author: text(author),
      when: relativeEpoch(epoch),
      at: Number(epoch) || 0,
      refs: text(refs).split(",").map((r) => r.trim()).filter(Boolean),
      subject: text(subject),
    });
  }
  return commits;
}

// File counts per commit, as `git log --shortstat` prints them beside each hash: how big a
// change was, in the terms a tooltip can say out loud.
export function parseStats(out) {
  const stats = {};
  let hash = null;
  for (const line of String(out || "").split("\n")) {
    const value = line.trim();
    if (/^[0-9a-f]{7,64}$/.test(value)) { hash = value; continue; }
    const found = value.match(/^(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
    if (hash && found) stats[hash] = { files: Number(found[1]) || 0, adds: Number(found[2]) || 0, dels: Number(found[3]) || 0 };
  }
  return stats;
}

// Lane assignment in topological order (the log's order): a commit takes the
// lane expecting its hash; a merge takes the lane expecting its FIRST parent
// instead (the merged branch joins from the side, like git draws it); a
// commit nobody expects takes the leftmost free lane. Every row records, per
// lane: pass-through, the node, a fork (a new lane starting here) or a join
// (a lane ending into the node). Colors stay with the lane, so lines never
// change color mid-run.
export function layoutLanes(commits) {
  const byHash = new Map(commits.map((c, i) => [c.hash, i]));
  const lanes = []; // lanes[i] = hash expected next on lane i, else null
  const rows = [];
  for (const c of commits) {
    const first = c.parents[0];
    let lane = lanes.indexOf(c.hash);
    if (lane === -1 && c.parents.length > 1 && first && byHash.has(first)) {
      lane = lanes.indexOf(first);
    }
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lane = lanes.length; lanes.push(null); }
    }
    const cells = lanes.map((tip, j) => {
      if (j === lane) return "node";
      return tip === null ? "empty" : "pass";
    });
    const joins = [];
    const forks = [];
    // First parent continues this lane; unknown (outside -n) ends it.
    lanes[lane] = first && byHash.has(first) ? first : null;
    for (const parent of c.parents.slice(1)) {
      if (!byHash.has(parent)) continue;
      const at = lanes.indexOf(parent);
      if (at === -1) {
        let free = lanes.indexOf(null);
        if (free === -1) { free = lanes.length; lanes.push(null); }
        lanes[free] = parent;
        forks.push(free);
      } else if (at !== lane) {
        joins.push(at);
        // That lane's tip is consumed by this join.
        lanes[at] = null;
      }
    }
    rows.push({ commit: c, lane, cells, joins, forks });
  }
  return { rows };
}

// A worktree's folder name. gh-new keeps its own copy of this rule (a mod cannot import from
// another folder), and the panel finds a worktree by the name the dialog gave it: the two must
// match by value.
export const slug = (name) => String(name ?? "")
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/\.{2,}/g, "-")
  .replace(/^[.\-]+|[.\-]+$/g, "");

// owner/name from an https://, ssh:// or scp-like github remote. The host is anchored, so a
// path that merely contains "github.com/" on another server is not read as GitHub.
export function nwo(url) {
  const match = /^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|git@)?(?:www\.)?github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/*$/i
    .exec(String(url ?? "").trim());
  if (!match) return null;
  const [, owner, name] = match;
  if ([".", ".."].includes(owner) || [".", ".."].includes(name)) return null;
  return `${owner}/${name}`;
}

// Mirrors gh-new's naming: "#53 Worktree rows, per-tree tabs" -> 53-Worktree-rows-per-tree-tabs
export function issueName(number, label) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n <= 0) return "";
  number = n;
  const title = String(label ?? "").replace(new RegExp(`^#?${number}[\\s:.-]*`), "");
  const name = slug(title ? `${number}-${title}` : String(number));
  return name.length > 48 ? name.slice(0, 48).replace(/-+$/, "") : name;
}
