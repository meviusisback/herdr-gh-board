// The wall's set: which agents a click asks for, tried outside the app:
// `bun test mods/agent-wall/set.test.js`.
import { test, expect } from "bun:test";
import { activeAddresses, leftWall, pinned, place, rebuild, wallSet } from "./set.js";

const a = (address, status) => ({ address, status });
const all = [a("t1", "idle"), a("t2", "working"), a("t3", "blocked"), a("t4", "done")];
const at = (list) => list.map((x) => x.address);

test("active is working and blocked, never done or idle", () => {
  expect(activeAddresses(all)).toEqual(["t2", "t3"]);
  expect(activeAddresses([a("t9", "done")])).toEqual([]);
  expect(activeAddresses([])).toEqual([]);
});

test("no mode and no list means every agent", () => {
  expect(wallSet(all, null, null, null)).toEqual(all);
});

test("a composed list keeps today's widening, a filter never widens", () => {
  // Two composed, one gone: back to every agent, as before.
  expect(at(wallSet(all, null, null, ["t2", "dead"]))).toEqual(["t1", "t2", "t3", "t4"]);
  // Two frozen active, one gone: the filter stays the filter.
  expect(at(wallSet(all, "active", ["t3", "dead"], null))).toEqual(["t3"]);
});

test("a frozen active set survives its agents going idle", () => {
  const later = [a("t2", "idle"), a("t3", "idle"), a("t4", "working")];
  expect(at(wallSet(later, "active", ["t2", "t3"], null))).toEqual(["t2", "t3"]);
});

test("an active set that never existed is empty, not everything", () => {
  expect(wallSet(all, "active", [], null)).toEqual([]);
  expect(wallSet(all, "active", ["dead"], null)).toEqual([]);
});

test("active mode with no frozen list is empty, never every agent", () => {
  // `mode` and `FEAT` are two writes: a partial write, or state from an older copy, can
  // leave the mode without its list. Widening there would light the active half over a
  // wall of every agent — the one contradiction this module exists to prevent.
  expect(wallSet(all, "active", null, ["t1"])).toEqual([]);
  expect(wallSet(all, "active", "garbage", ["t1"])).toEqual([]);
  expect(pinned("active", null, ["t1"])).toEqual([]);
});

test("a spent filter is dropped by the key, but never widened under a wall", () => {
  // Two frozen, one left. With the wall down the key must open what it means — every
  // agent — instead of refusing forever with a dead snapshot's count.
  expect(rebuild(all, "active", ["t3"], null, false)).toEqual({ set: all, spent: true });
  // With the wall up, the set stays small on purpose: `on` leaves for tabs instead.
  expect(rebuild(all, "active", ["t3"], null, true)).toEqual({ set: [all[2]], spent: false });
  // A filter that still has its two is a filter, up or down.
  expect(at(rebuild(all, "active", ["t2", "t3"], null, false).set)).toEqual(["t2", "t3"]);
  expect(rebuild(all, "active", ["t2", "t3"], null, false).spent).toBe(false);
  // No filter, nothing spent.
  expect(rebuild(all, null, null, null, false)).toEqual({ set: all, spent: false });
});

test("the mode picks the list, and duplicates and junk are dropped", () => {
  expect(pinned("active", ["t2"], ["t4", "t1"])).toEqual(["t2"]);
  expect(pinned(null, ["t2"], ["t4", "t1", "t4"])).toEqual(["t4", "t1"]);
  expect(pinned(null, ["t2"], "garbage")).toBe(null);
});

test("a place is its space and tab, joined", () => {
  expect(place({ space: "sp1", tab: "tb1", pane: "p1" })).toBe("sp1|tb1");
  expect(place({ space: "sp1", tab: null })).toBe(null);
  expect(place(null)).toBe(null);
  expect(place({ space: null, tab: "tb1" })).toBe(null);
});

test("the wall leaves for a pick, never for a missing side", () => {
  expect(leftWall("sp1|tb1", "sp1|tb2")).toBe(true);
  expect(leftWall("sp1|tb1", "sp2|tb1")).toBe(true);
  expect(leftWall("sp1|tb1", "sp1|tb1")).toBe(false);
  expect(leftWall(null, "sp1|tb1")).toBe(false);
  expect(leftWall("sp1|tb1", null)).toBe(false);
  expect(leftWall("", "")).toBe(false);
});
