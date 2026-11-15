// The wall's set, as data: which agents a click asks for, and which of them the wall can
// still show. Pure, so the two decisions that can go wrong live outside the app and under
// `bun test mods/agent-wall/set.test.js`.
//
// The one asymmetry that matters: a composed list (`agent-wall.list`, what a drag picked)
// widens back to every agent when fewer than two of its members survive — a wall needs two.
// A frozen active set (`agent-wall.mode` = "active") never widens: widening it would answer
// "the agents working now" with "all of them", which is not what was clicked.
export const LIVE = ["working", "blocked"];
export const isActive = (agent) => LIVE.includes(agent?.status ?? "idle");
export const activeAddresses = (agents) => agents.filter(isActive).map((agent) => agent.address);

// The addresses the wall was asked for: the frozen ones while the mode is a filter, else
// the composed ones. null — and any junk in shared state — means every agent, except under
// a filter: there, a missing list means nothing is frozen, never everything.
export function pinned(mode, active, list) {
  const chosen = mode === "active" ? (Array.isArray(active) ? active : []) : list;
  return Array.isArray(chosen) ? [...new Set(chosen)] : null;
}

// What the wall shows: the pinned agents that still exist, in their order. A filter is
// returned as it is (even at none or one, so the caller can refuse or leave); anything else
// falls back to every agent at fewer than two, as the wall always has.
export function wallSet(agents, mode, active, list) {
  const chosen = pinned(mode, active, list);
  if (!chosen) return agents;
  const by = new Map(agents.map((agent) => [agent.address, agent]));
  const kept = chosen.filter((address) => by.has(address)).map((address) => by.get(address));
  return mode === "active" || kept.length >= 2 ? kept : agents;
}

// The agents `on()` should build from, and whether it must clear a spent filter first.
// `up` is whether the wall is showing. A filter that has lost all but one of its agents is
// spent: with the wall down, the key opens what the key means — the wall of every agent —
// instead of refusing forever with a dead snapshot's count; with the wall up, the set stays
// this small on purpose, so `on` leaves for tabs rather than silently widening the wall the
// person is looking at.
export function rebuild(agents, mode, active, list, up) {
  const set = wallSet(agents, mode, active, list);
  if (mode !== "active" || set.length >= 2) return { set, spent: false };
  return up ? { set, spent: false } : { set: agents, spent: true };
}

// Where the window is: the space and tab, as one comparable string. Every way of picking a
// place — a tab, a space row, an agent, a key, the palette — either moves this or moves
// nothing, so the wall can tell a pick from its own focus moving between tiles.
export const place = (focused) =>
  focused?.space && focused?.tab ? `${focused.space}|${focused.tab}` : null;

// Whether the person picked a place other than the one the wall stood on. A missing side is
// not a pick: a wall written before this state existed, or a window between layouts, must
// never leave on its own.
export const leftWall = (entered, now) => Boolean(entered) && Boolean(now) && entered !== now;
