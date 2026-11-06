# Issues & PRs

A panel for Herdr that lists the open issues and pull requests of every GitHub repo checked out in one folder, shows one's full details on hover or pinned at the bottom of the column, turns one into a git worktree with a coding agent already running in it, follows agent selection both ways, and shows every worktree grouped by repo in a second panel.

![Issues & PRs](preview.png)

## What you see

The package is a layout (`main-gh`) and seven mods, so what you see is Herdr's own window with five changes.

**The tab bar** gains two panel buttons after `Files` and `Changes`: `Issues` (a circle-with-dot icon, `mods/gh-board/inbox.svg`) and `Trees` (a branch icon), 26 px tall, same active/inactive look as the other two. The `+` menu pins favourite agents to the top (Hermes, Oh My Pi, Pi — edit `PINNED` in `mods/new-menu-pinned/main.js`).

**The right column** is Herdr's `panel` node, open by default: 368 px (min 280, max 900). Inside it the `panel-body` stack gained two children, `gh-board` and `gh-trees`, next to `files` and `changes`. Each panel draws its own card on the theme: `rounded(10)`, 1 px `border`, `background` fill, 12.5 px text. The column stays open in every space; each space remembers which panel it had (or that it was closed), and a space never touched opens on Issues.

Top to bottom:

1. **Header, 36 px**: `Issues & PRs` in semibold, a `Repos 21/21` button (picked of scanned), a `New` button, and `Refresh`, which turns into a native spinner (`frames(["◐","◓","◑","◒"], 200)`) while a refresh runs. All three are text buttons, 20 px tall, `muted` until hovered.
2. **Filter bar**: three chips — `All N`, `Issues N`, `PRs N` — 22 px tall, `raised` fill, `selected` fill for the active one; and, right-aligned, `Changes requested N ✕` in `ansi1` (red) on a 13% red tint when on. All four sit on one line when they fit; `flex_1` spacer before the red chip pushes it right, and when the estimated widths do not fit the red chip moves to a second line, still right-aligned. Nothing overlaps: the label truncates, the count and the ✕ do not.
3. **The list**, scrollable, 6 px padding, 1 px gaps. One row per item, two lines in a narrow panel: line one is the kind pill (`PR`, 22 px wide, `ansi5` purple; or `Issue`, 40 px, `ansi2` green, these colours at 13% for the fill), the repo name (`muted`, truncated), the tags, `#number`, the age, and the branch button; line two is the title in `foreground`, truncated. Tags are 16 px pills: `draft` (`dim`), `approved` (`ansi2`), `changes requested` (`ansi1`), then the item's own labels. A wide panel (620 px+) puts everything on one 30 px row and adds the author. A selected row keeps a `selected` fill.
4. **The docked card**, 300 px tall, `background` fill with a top border, only while a row is selected: header (`PR`/`Issue` pill, `#number`, repo, state, `✕`), the title at 13 px semibold, a `dim` meta line (`by author · opened 2026-11-01 · updated 5h`), the tags, a stats line in the item's tone (`+3334 −300 · 24 files · fixes → main · changes requested`), the description as markdown (`TextView.markdown`, 11.5 px, `muted`, filling and scrolling in the leftover space), and a footer with `Open worktree` (solid when that worktree exists), `New worktree` (solid when it does not) and `GitHub ↗`.
5. **Status line, 24 px**: `5 of 5 shown` (or the error, in `ansi1`), `N failed` in `ansi3` when some repos could not be asked, and `updated 4m ago`.

**The Trees panel** lists every checkout under `~/repo` grouped by repo: a dim 11 px repo header, then one 28 px row per tree — branch icon, folder name (or `main` for the main checkout, tagged `checkout` on the right), branch name in `dim` when it differs. The active space's folder is `selected`. A header (`Worktrees`, `Refresh`) and a footer (`N worktrees in M repos`). 15 s refresh.

**Two dialogs** open from the Issues panel, both `frame: "none"` so they draw their own card on `popover` with `rounded(12)` and `shadow_lg`:

## How it behaves

**Data.** On start the mod reads `~/repo` (or `shared("gh-board.root")`), runs `git config --get remote.origin.url` in every subfolder, keeps the unique `github.com` remotes, publishes `[{repo, dir}]` as `shared("gh-board.repos")`, prunes `shared("gh-board.selected")` to the repos that still exist, and then asks `gh api graphql` once per 20 repos for `issues(states: OPEN, first: 50)` and `pullRequests`, sorted by `UPDATED_AT`. Items are sorted newest-updated first. It refreshes every 60 s, on `Refresh` (which also rescans the folder), and whenever another mod changes the picked repos, the folder, or asks for a rescan.

**States.** Working, blocked, done and idle appear as ordinary rows (an agent's own reporting is not involved). A PR with `reviewDecision: CHANGES_REQUESTED` gets the red `changes requested` tag everywhere, and can be filtered out.

**Filters.** `All` / `Issues` / `PRs` are exclusive, act on `on_mouse_down` (not the click cycle) and persist in `localStorage`. `Changes requested` narrows the same list on top of the active tab and persists too; its count is the number hidden while it is on. Changing either gives the list a new element id, so it starts at the top instead of keeping the old scroll offset.

**Hover.** Resting on a row for a moment fetches that item's details (`gh pr view` / `gh issue view --json`) once, cached until its `updatedAt` changes, and shows a 440 px card in a `Popup` layer anchored `right_center` of the row: same content as the docked card, but with the description in a fixed box (up to 320 px, estimated from the wrapped line count) instead of filling the column. Leaving the row and not entering the card closes it after 220 ms. Only the row under the pointer builds a card.

**Click.** A row selects it (docked card, second click closes) *and* jumps to the agent working on that issue when one exists (`openExisting`: `space.select` + `tab.select`). The branch button opens the item's existing worktree if there is one, otherwise the `Worktree + agent` dialog. Selecting the `New` button opens the same dialog in `from scratch` mode.

**Follow both ways.** Clicking an agent in the sidebar (`agents-follow`) writes `shared("gh-board.follow")` `{folder, tab, cwd, at}`; the board resolves the issue/PR number from the tab (`#28 …`) or the worktree branch (`28-…`), scopes it to the repo (checkout containing the folder, else the worktree's repo dir name), prefers an open PR on a number tie, selects the row and docks its card — clearing the selection when nothing matches. The filter is widened to `all` (and the changes-requested filter lifted) when it would hide the target. A follow is applied once per click (`followKey`), retried across renders while the list loads, and a stale follow present at board start is ignored.

**Trees.** `gh-trees` runs `git worktree list --porcelain` in every checkout under `~/repo` every 15 s. A row click runs `space.select` on the space whose folder is that path, or `space.new {name, folder}` when none shows it. The active space's folder highlights.

**Panel memory.** `tabs-gh` remembers the open panel per space id in `localStorage` (`panels`): switching spaces restores that space's panel, opening/closing records it. A space with no memory opens on Issues — only an explicit close (`null`) keeps the column shut.

**The dialogs.** In `Worktree + agent` the worktree and branch default to `slug("<number>-<title>")` of the item (or the repo folder's name from scratch); the agent defaults to the one remembered in `shared("gh-board.agent")`, else the first installed. `Create` first asks git whether the branch is a branch at all (`git check-ref-format --branch`), then does `git worktree add` into `~/.herdr/worktrees/<repo>/<name>` (with `-b <branch> HEAD` when the branch does not exist; `--` before every positional), then `space.new {name: <worktree>, folder: <worktree>, tab: "<#number> title", argv: <agent>}` — named after the worktree (usually the branch), repo-prefixed then numbered only on a clash, so two checkouts of one repo never share a space name. The path must stay under `~/.herdr/worktrees/`, and a folder git does not know is initialised only when git says "not a git repository", never `$HOME` or `/`. If that folder is already a space it selects it and adds the tab instead. Escape, the dialog frame's ✕-free cancel path or `Cancel` closes it; Enter in either field creates.

**In the repo picker**, clicking a row toggles it immediately (shared state, so the panel refetches behind the dialog), `All` sets the selection to `null` (meaning every repo), `None` to an empty list, `Folder…` calls Herdr's system folder picker and `Rescan` bumps `shared("gh-board.rescan")`.

**Keys.** None of its own: it uses Herdr's.

## Built from

The layout is Herdr 0.1.11's `main`, copied by `layout.clone`, with four edits: the `tabs` block's `content.mod` is `tabs-gh`, the `agents` block's is `agents-follow`, `panel-body` (the stack in the `panel` column, min 280 / max 900, shown, `active: gh-board`) gained two blocks:

```json
{ "id": "gh-board", "type": "block", "content": { "mod": "gh-board" } },
{ "id": "gh-trees", "type": "block", "content": { "mod": "gh-trees" } }
```

`mods/tabs-gh` is Herdr 0.1.11's `tabs` copied by `mod.clone`, with `gh-board` and `gh-trees` unioned into the `enabled` list (so a `workspace.panels` value that predates them does not hide the buttons), two more `panelButton`s (`Issues`, `Trees`), the `+` button pointed at `new-menu-pinned`, and the per-space default-open panel memory above.

`mods/agents-follow` is Herdr 0.1.13's `agents` copied by `mod.clone`: both row clicks call `follow(a)` (`pane.focus` + the `gh-board.follow` write) instead of `pane.focus` alone. Everything else is the shipped mod.

`mods/new-menu-pinned` is Herdr 0.1.13's `new-menu` copied by `mod.clone`: the installed list is stable-sorted by `pinRank` (`PINNED = ["hermes", "oh-my-pi", "pi"]`, matched case-insensitively against key + name). Non-matching entries are ignored; the `1-9` shortcuts follow the sorted order.

`mods/gh-trees/main.js` (≈110 lines) is the worktree browser: `fs/promises` `readdir` + `exec("git", ["-C", dir, "worktree", "list", "--porcelain"])`, `spaces()` for the highlight and the jump, `run("space.select"/"space.new")`. Its own `branch.svg` (copied from gh-board's).

`mods/gh-board/main.js` (≈570 lines) is the panel: `View` with `init(props, cx)`, a 60 s `cx.timer.every`, and `cx.spawn` for every host call. It uses `div/h_flex/v_flex`, `Popup`, `TextView.markdown`, and from `herdr`: `exec`, `home()`, `theme()`, `settings()`, `openOverlay`, `run`, `spaces`, `shared`, `setShared`, plus `fs/promises`' `readdir`. Commands it runs: `space.select`, `tab.select`, `pane`-free; programs: `git`, `gh`, `xdg-open`/`open`. Images: `mods/gh-board/branch.svg` (octicon git-branch, 16 px grid) and `mods/gh-board/inbox.svg` (octicon issue-opened).

Each `mod.json` carries `"version"` (this package: `1.0.0`), which is what an installed copy can be told apart by.

`mods/gh-new/main.js` is the dialog: `InputState` + `Input` for the two names, three `Popover`s (repo, branch, agent), `pickFolder()` for "other folder", `knownAgents()` for the list, and `exec("git", …)` + `run("space.new")` to make the checkout. Its own `check.svg`.

`mods/gh-repos/main.js` is the picker: `pickFolder()`, `shared`/`setShared`, `svg` for the checkmark.

Shared state between them: `gh-board.repos` (`[{repo, dir}]`), `gh-board.selected` (`null` or `[owner/name]`), `gh-board.root` (folder), `gh-board.rescan` (a timestamp), `gh-board.agent` (an agent name, `null`, or `"shell"`), `gh-board.follow` (`{folder, tab, cwd, at}` from the last agent click).

## Watch out

- **Four clones, one copy each.** `main-gh`, `tabs-gh`, `agents-follow` and `new-menu-pinned` are snapshots: they do not track Herdr. Re-clone and re-apply the edits above when you want the shipped versions' improvements.
- **The panel is where the clones meet.** Without `tabs-gh` there is no `Issues` button; without the `gh-board` block in `panel-body` the button toggles nothing. Both edits are one line each.
- **Names must match across mods.** `gh-board` finds a worktree by path: `~/.herdr/worktrees/<repo folder name>/<slug(number-title)>`, and the tab by its name (`"#12 title"`, truncated to 64). `gh-new` builds the same two strings. Change the naming formula in one and "Open worktree" stops finding the other's worktrees. The `slug()` in both mods must stay identical: it keeps `[A-Za-z0-9._-]`, collapses dot runs, and trims leading/trailing dots and dashes, so a name is valid both as a path component and as a git ref — and both sides need the `|| "repo"` fallback for a folder whose name survives as nothing (a non-ASCII folder name).
- **Widths are estimated.** The one-line/two-line decision for the filter chips uses a character-width estimate (`0.56 × font size` in the monospace UI font, times `settings().zoom`, plus padding and 12 px slack), calibrated against a 396 px panel at zoom 1.1. A very different zoom or font may wrap a little early or late — never overlap.
- **One `spaces()` per render.** Every call into the app is a host round trip; calling it per row made every re-render (and so every filter click) slow. The render builds one `Set` of space folders and `ready(item)` consults it.
- **Issue text is untrusted input.** `cleanBody()` strips control/bidi codepoints, markdown images, `<img>` and script-ish tags, and caps the body at 4000 chars before `TextView.markdown`; the links inside go through `on_link_click` → `openGitHub`, which accepts only `https://github.com/…` and hands it to the host's guarded opener (`cx.open_url`), never to `exec("xdg-open")`. Labels that collide with the panel's own `draft` / `approved` / `changes requested` tags are dropped by `tags()`.
- **A refresh request is never dropped.** `refresh()` returns immediately when a fetch is in flight, so `render()` records the changed key and `refresh()` re-runs once from its `finally` (`this.pending`). Without that, toggling a repo or changing the folder during a fetch did nothing until the 60 s tick.
- **Only one hover card is built.** Building a card (with a markdown parse) for every visible row made clicks sluggish; the card is built only for the hovered row via `Popup` + `hoverKey`, with a 220 ms close delay and a `hoverHold` flag so moving into the card keeps it.
- **Ids must be unique per render.** The docked card and the hover card render the same buttons; they use `gh-dock-…` and `gh-card-…` prefixes. Duplicated ids cost hit-testing.
- **A broken render leaves a strip.** While developing this I saved a build that threw during render and Herdr showed "This view could not be re-rendered…" inside the block until the block was recreated; `herdr-app status` reported no error. `layout.hide`/`layout.show` on the block clears it.
- **Repo names come from `git`.** A folder whose `origin` is not `github.com` is skipped entirely — no error, it just is not in the list.
- **Only the first 50 open items per repo** and the first 300 shown; the footer says so. GraphQL `issues` does not include PRs, so nothing is counted twice.
- **`gh` must be authenticated on this machine** — the panel shows `gh`'s own error text (in the status line) when it is not.
- The `Oh My Pi` entry that the screenshots show was added by hand in `programs.json` (`run: ["omp"]`); it is not part of this package.

## Done when

1. `herdr-app check` passes for all seven mods.
2. `herdr-app do layout.switch --name main-gh` shows `Issues` and `Trees` buttons in the tab bar; the right column is open on `Issues & PRs` with a `Repos N/N` count and as many rows as the folder's repos have open items (or `Nothing open`, which is a valid result).
3. Clicking `All` / `Issues` / `PRs` changes the rows within a frame, and the counts in the chips match the rows.
4. With at least one PR in `changes requested`, the chip appears red at the right; clicking it removes those rows and adds a `✕`, and the ✕ puts them back.
5. Clicking `Repos` lists every repo the panel scanned, `All` / `None` change the count in the panel behind it, and `Rescan` picks up a checkout created after the panel started.
6. Hovering a row shows a card to its left with a real description; clicking the row docks the same card at the bottom of the column with `Open worktree` / `New worktree` / `GitHub` — and switches to that issue's agent tab when one exists.
7. `New worktree` on a PR opens the dialog with the worktree and branch named after it; `Create` produces a space named after the worktree (unique per checkout, never one name per repo), containing a checkout under `~/.herdr/worktrees/` (verify with `git worktree list` in the repo) and a tab named `#<number> <title>` running the chosen agent with an empty prompt.
8. On that same PR, the branch button now switches to that space instead of opening the dialog, and the icon is accent-coloured.
9. In the dialog, `Branch` = `--force` (or `a..b`) is refused with "not a valid branch name" before anything is written, and `Worktree` = `.` or `..` never leaves `~/.herdr/worktrees/` (it becomes `worktree`).
10. An issue whose body contains `![x](https://example.com/p.png)` and `<img src=…>` renders as text only, and the panel's footer/description does not grow the panel: images are gone, the body is capped.
11. Clicking an agent in the sidebar selects its issue/PR in the Issues panel and docks the card; clicking an agent that works on no issue clears the selection.
12. The `Trees` button shows every checkout under `~/repo` grouped by repo with the active space highlighted; clicking another row switches to (or opens) that space.
13. Closing the right column on one space and switching spaces keeps it closed there but open elsewhere; a space never touched opens on Issues.
14. The `+` menu lists the `PINNED` agents first, in order, with `1-9` shortcuts following that order.
