// The pure helpers the git panel is built on: parsed outside the app so a later edit cannot
// quietly change what a row says. `bun test mods/gh-git/format.test.js`
import { test, expect } from "bun:test";
import {
  tint, text, relativeEpoch, relativeIso, parseLog, parseStats, layoutLanes,
  issueName, slug, atKey, nwo,
} from "./format.js";

test("a colour takes an alpha only when it is #rrggbb", () => {
  expect(tint("#112233", "80")).toBe("#11223380");
  expect(tint("red", "80")).toBe("red");
  expect(tint(undefined, "80")).toBe(undefined);
});

test("display text loses control and bidi codepoints", () => {
  expect(text("a\u202eb\u0000c")).toBe("abc");
  expect(text("plain")).toBe("plain");
});

test("relative times use one set of thresholds", () => {
  expect(relativeEpoch(Math.floor(Date.now() / 1000) - 120)).toBe("2m");
  expect(relativeEpoch(Math.floor(Date.now() / 1000) - 90000)).toBe("1d");
  expect(relativeIso("not a date")).toBe("");
});

test("the commit log keeps only records whose hash is a hash", () => {
  const now = Math.floor(Date.now() / 1000);
  const good = `abcdef1\x1fabc\x1fAnn\x1f${now}\x1forigin/main, main\x1ffeat: hi`;
  const forged = `not-a-hash\x1f\x1fEve\x1f${now}\x1f\x1frenamed`;
  const hostile = `abcdef2\x1f\x1fBad\x1f${now}\x1f\x1fde\u202etector`;
  const out = `${good}\x1e${forged}\x1e${hostile}\x1e`;
  const log = parseLog(out);
  expect(log.length).toBe(2);
  expect(log[0].hash).toBe("abcdef1");
  expect(log[0].parents).toEqual(["abc"]);
  expect(log[0].refs).toEqual(["origin/main", "main"]);
  expect(log[0].when).toBe("now");
  expect(log[1].subject).toBe("detector");
});

test("shortstat becomes per-commit file counts", () => {
  const hash = "abcdef1234567";
  const out = `\n${hash}\n 3 files changed, 10 insertions(+), 2 deletions(-)\n`;
  expect(parseStats(out)).toEqual({ [hash]: { files: 3, adds: 10, dels: 2 } });
});

test("a linear log stays in one lane", () => {
  const { rows } = layoutLanes([{ hash: "b", parents: ["a"] }, { hash: "a", parents: [] }]);
  expect(rows.map((row) => row.lane)).toEqual([0, 0]);
  expect(rows[0].cells[0]).toBe("node");
});

test("a merge joins the lane its first parent already holds; an unknown second parent is skipped", () => {
  const { rows } = layoutLanes([
    { hash: "a", parents: ["b"] },
    { hash: "c", parents: ["b", "d"] },
    { hash: "b", parents: [] },
  ]);
  expect(rows[1].lane).toBe(0);
  expect(rows[1].forks).toEqual([]);
});

test("a worktree name reads the issue title the same way gh-new does", () => {
  // slug keeps the case of the title (gh-new's slug does too; the two must agree).
  expect(issueName(53, "#53 Worktree rows, per-tree tabs")).toBe("53-Worktree-rows-per-tree-tabs");
  expect(issueName(0, "x")).toBe("");
});

test("slugs collapse runs and trim the edges", () => {
  expect(slug("a b..c")).toBe("a-b-c");
});

test("the read key separates machines", () => {
  expect(atKey({ folder: "/x", on: "m" })).toBe("m|/x");
  expect(atKey({ folder: null, on: "m" })).toBe("");
});

test("a remote is GitHub only when its host is GitHub", () => {
  expect(nwo("https://github.com/owner/name")).toBe("owner/name");
  expect(nwo("git@github.com:owner/name.git")).toBe("owner/name");
  expect(nwo("ssh://git@github.com/owner/name.git")).toBe("owner/name");
  expect(nwo("https://www.github.com/owner/name")).toBe("owner/name");
  // A path that merely contains github.com/ on another server is not that repo.
  expect(nwo("https://notgithub.com/owner/name")).toBe(null);
  expect(nwo("https://evil.example/github.com/owner/name")).toBe(null);
  expect(nwo("https://github.com/owner/name?x=1")).toBe(null);
  expect(nwo("https://github.com/../name")).toBe(null);
});

test("display text loses C1 controls too", () => {
  expect(text("a\u009bb\u0085c")).toBe("abc");
});
