# Repos & Agents

A Herdr window built around the repos you keep in one folder: a sidebar that is a tree of every
repo → its main checkout, branches and worktrees → the agents running in each, how far each one
is from origin and from main, and in what state its agents are; one git panel on the right
(every worktree, the commit graph, the open issues and PRs); and a wall that shows the running
agents side by side without moving anything.

![Repos & Agents](preview.png)

Layout `repos-and-agents` and 17 mods. Install it by asking your agent to read this repo (see
[RECIPE.md](RECIPE.md)) or by copying `layouts/repos-and-agents.json` and `mods/` into
`~/.config/herdr-app/` and merging `keys.json`. Herdr's own mods stay Herdr's: this uses the ones
every install already has.

## What you see

- **Sidebar** (320 px, 44–480, theme `chrome`): Herdr's brand row on top, then the spaces tree,
  then Herdr's footer (Settings, Add machine). The tree is two lists. **Repos** holds every repo
  under the folder Settings names (`~/repo` unless changed): one row per repo — a colored square
  with its initials, its name, how many agents sit under it and in what state, git buttons, and
  `+` / bot / GitHub marks. Under it: `Main` (its own checkout), then a row per branch or
  worktree, then a row per agent with the prompt it is on and its model. **No repo** holds the
  spaces whose folder is no checkout, one row each with their agents under it. A filter box and
  a sort/only control sit above both lists.
- **Tab bar** (42 px): the space's tabs, `+`, then the panels' buttons (Files, Changes, Git) and
  the wall chip at the right end. On Linux and Windows it draws the window's own buttons.
- **The tab's panes**, 8 px apart on the `canvas` background, each framed as a card with a 10 px
  radius and a 1 px `border` (`accent` while focused), under a 30 px header: the program's icon,
  the agent's name or the terminal's title, its status, the folder, the agent's last prompt on
  the right, and split / zoom / close.
- **Git panel** (368 px, 280–900): one panel with three views — `Trees` (every checkout of every
  repo, the shown space's highlighted), `Commits` (the commit graph of the shown repo, with
  files and stats) and `Issues` (open issues and PRs of the picked repos, with their
  conversations). It refreshes every 15 s.
- **Status bar** (34 px): bottom left the machine and the repo the agents on screen share; bottom
  right how far that space is from origin and from main, then every agent state with its count,
  as chips.
- **The wall**: `Ctrl+Shift+G` (or the chip) turns the window into a grid of the running agents'
  live terminals, across spaces, each tile headed by its space, program, state and branch.

## How it behaves

- An agent's state comes from the agent itself and colours every chip above it: working, blocked
  (needs you), done (finished while you weren't looking), idle. A repo row counts its agents'
  states; the status bar counts everyone.
- A branch row's chips say how far it is from `origin` (ahead/behind, or local-only) and from
  `main`, and whether the checkout has uncommitted changes. Clicking a repo folds it; a branch row
  goes to that space; an agent row goes to that agent. Right-click a space, repo, branch or agent
  for its menu.
- On an uncommitted checkout, `✎` opens Commit (drafted message, paths picked one by one); on a
  branch ahead of main, `main+N` opens Merge. A repo with no `github.com` remote shows the GitHub
  mark: it creates the repo with `gh`, pushes, and gives the branch its upstream.
- A branch row's bot opens the `+` menu for that branch, as a comic bubble, so an agent starts in
  that branch's own space instead of the shown one.
- `+` in the tab bar starts a shell or an agent in a new tab; New space asks for a name first and
  gives the space a folder of its own (`~/spaces/<name>`, or a new repo under the repos folder);
  New worktree opens one from a branch or from an issue/PR.
- A pane's header can start a live test of the folder's dev server and open its page.
- The wall keeps nothing running differently: each agent stays in its space, and picking a tab,
  agent or space leaves the wall for it. The set it shows is remembered.
- All of it follows the theme (`canvas`, `chrome`, `border`, `accent`, the status colors) and
  works on several machines: a space on another machine has its git read there.

## Keys

`Ctrl+Shift+G` wall · `Ctrl+Shift+N` new space · `Ctrl+Shift+Alt+S` Settings (repos folder) ·
`Ctrl+Shift+Alt+T/C/I` the Git panel's Trees, Commits, Issues. Herdr's own keys are untouched;
`keys.json` is a merge, and the installer asks before replacing a key you already use.

## License

MIT (see [LICENSE](LICENSE)). The mods cloned from Herdr's own are Apache-2.0 derivatives — see
[NOTICE](NOTICE).
