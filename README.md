<div align="center">

# Issues & PRs — a Herdr panel

**Every open issue and pull request of the GitHub repos you keep in one folder, in a side panel — and one click from an issue to a worktree with an agent already sitting in it.**

[![Herdr](https://img.shields.io/badge/herdr-0.1.11%2B-6d5efc?style=flat-square)](https://herdr.dev)
[![kind](https://img.shields.io/badge/kind-layout-2f81f7?style=flat-square)](#install)
[![mods](https://img.shields.io/badge/mods-3-8957e5?style=flat-square)](#what-is-in-the-box)
[![needs](https://img.shields.io/badge/needs-gh%20%7C%20git-2ea043?style=flat-square)](#requirements)
[![platform](https://img.shields.io/badge/platform-linux%20%7C%20macOS-8b949e?style=flat-square)](#requirements)
[![network](https://img.shields.io/badge/network-gh%20API%20only-d29922?style=flat-square)](#what-it-talks-to)
[![license](https://img.shields.io/badge/license-MIT-3da639?style=flat-square)](LICENSE)

<img src="preview.png" alt="Herdr with the Issues & PRs panel open on the right" width="100%">

</div>

---

## What you get

- **One list, every repo.** Scans a folder (`~/repo` by default), reads each checkout's `origin` remote, and asks `gh` for the open issues and PRs — one batched GraphQL query per 20 repos, so a refresh is two requests and about a second.
- **A real panel, not a window.** It lives in the same right-hand column as Herdr's *Files* and *Changes*, opens from an **Issues** button in the tab bar, and each space remembers whether you had it open.
- **Details on hover, pinned on click.** Hover a row for a card with the description rendered as markdown, state, author, dates, labels, review state and diff stats. Click it and the same card docks at the bottom of the column, where it stays while you scroll.
- **Filters that behave.** `All` / `Issues` / `PRs` are tabs; `Changes requested` is a separate filter you can switch on and take off with its ✕. They sit together when they fit, and it wraps to its own line when the panel is too narrow.
- **Repo picker.** Choose which repos are asked about, rescan the folder, or point the panel at a different folder entirely.
- **Issue → worktree → agent in two clicks.** The branch button on a row opens a small dialog: the worktree and the branch are already named after the issue, the agent is the one you used last, and `Create` gives you `~/.herdr/worktrees/<repo>/<name>` as a space with that agent waiting for input. If the worktree is already there, the button just takes you to it.
- **Or start from nothing.** The panel's `New` button does the same without an issue: pick a repo (or any folder — it initializes it), a branch that exists or a new one, and the agent.

## The panel

<img src="docs/panel.png" alt="The Issues & PRs panel" width="100%">

Each row is one PR or issue: kind, repo, number, title, and — when the panel is wide enough — labels, review state and author. The branch icon on the right is the worktree shortcut; it turns accent-coloured when that worktree already exists. A click selects the row, a second click closes it.

## Details

<img src="docs/detail.png" alt="The selected PR docked at the bottom of the column" width="100%">

The docked card keeps the header (`PR #53 repo state ✕`), the meta line, the tags, the diff stats and the full description — scrollable — with the two worktree buttons and a GitHub link at the bottom.

## Worktree + agent

The dialog is pre-filled from the issue or PR: `#12 fix(probe): read Apple Silicon CPU and GPU temperatures` becomes the worktree and the branch `12-fix-probe-read-Apple-Silicon-CPU-and-GPU-temp`. Both are editable, and the agent is a dropdown that remembers your last pick.

<table>
<tr>
<td width="50%"><img src="docs/new-worktree.png" alt="Worktree + agent dialog, from a PR"></td>
<td width="50%"><img src="docs/from-scratch.png" alt="The same dialog, from scratch"></td>
</tr>
<tr>
<td>From an issue or PR: names taken from it.</td>
<td>From scratch: repo, branch (with its existing branches one click away) and agent.</td>
</tr>
</table>

`Create` runs `git worktree add` (a branch that already exists is checked out, a new one starts from `HEAD`), then `space.new` — so you get a space named after the repo, a tab named after the issue, and the agent running there with an empty prompt.

## Repos

<img src="docs/repos.png" alt="The repo picker" width="330">

Only the picked repos are queried. `Rescan` re-reads the folder, `Folder…` opens the system folder picker, and a selection that loses a repo (because you deleted the checkout) is pruned automatically.

## Install

Requires **Herdr 0.1.11 or newer**, and `gh` (logged in: `gh auth status`) and `git` on `PATH`.

```sh
APP=~/.config/herdr-app
git clone https://github.com/meviusisback/herdr-gh-board /tmp/herdr-gh-board
cp /tmp/herdr-gh-board/layouts/main-gh.json "$APP/layouts/"
cp -r /tmp/herdr-gh-board/mods/gh-board /tmp/herdr-gh-board/mods/gh-new \
      /tmp/herdr-gh-board/mods/gh-repos /tmp/herdr-gh-board/mods/tabs-gh "$APP/mods/"
herdr-app check "$APP/mods/gh-board"     # and gh-new, gh-repos, tabs-gh
herdr-app do layout.switch --name main-gh
```

Then open the panel with the **Issues** button in the tab bar (or `herdr-app do layout.select --stack panel-body --child gh-board && herdr-app do layout.show --id panel`).

If any of those mod names is already taken in your `~/.config/herdr-app/mods/`, rename the folders — and the `"mod"` names in `layouts/main-gh.json` and in `mods/tabs-gh/main.js` (`gh-board` in the `enabled` list and its `panelButton`) — to match.

## Requirements

| | |
|---|---|
| Herdr | 0.1.11+ (`herdr-app --version`) |
| `gh` | authenticated, with `repo` scope — the panel runs `gh api graphql` and `gh issue/pr view` |
| `git` | on `PATH`, for reading remotes and making worktrees |
| Folder | a folder of checkouts, `~/repo` by default (change it in the panel's `Repos` dialog) |

## What it talks to

Only `gh` (GitHub's API, with your own credentials) and `git`, both through Herdr's `exec`. Opening a row's `GitHub` button shells out to `xdg-open` (or `open` on macOS). Nothing is written outside `~/.herdr/worktrees/` when you create a worktree, and no state leaves `shared.json`.

## What is in the box

| Path | What it is |
|---|---|
| `layouts/main-gh.json` | Herdr's `main` layout with a `gh-board` block in the right column's stack, and the tab bar pointed at `tabs-gh` |
| `mods/gh-board/` | the panel: scan, query, list, filters, hover card, docked card |
| `mods/gh-new/` | the `Worktree + agent` dialog (both modes: from an item, from scratch) |
| `mods/gh-repos/` | the repo picker |
| `mods/tabs-gh/` | Herdr's `tabs` mod with one extra panel button (`Issues`) |

The mods talk to each other through Herdr's shared state: `gh-board.repos` (the scan), `gh-board.selected` (the picked repos), `gh-board.root` (the folder), `gh-board.rescan` (a request to re-read it) and `gh-board.agent` (the agent you picked last).

## Notes

- **The panel is a clone.** Herdr's shipped layouts and mods are read-only, so this package ships a copy of `main` (as `main-gh`) and of `tabs` (as `tabs-gh`), made from Herdr 0.1.11. They work as they are, but they do not receive Herdr's future updates — re-clone with `herdr-app do layout.clone '{"name":"main","as":"main-gh-2"}'` and copy the `gh-board` block over if you want a fresh one. `ctrl-shift-l` switches back to your own layout at any time.
- The worktree name is what the panel looks for: rename it in the dialog and the panel will not recognise that checkout again (the space is still created and selected).
- The agent list comes from Herdr's own table plus your `programs.json`; anything with a `run` entry shows up in the dropdown.
- `RECIPE.md` describes how the whole thing is built, if you want to change it rather than patch it.

## License

MIT — see [LICENSE](LICENSE). Do what you want with it.

---

<div align="center"><sub>Made for <a href="https://herdr.dev">Herdr</a>. Bugs and ideas: open an issue — the panel will show it to me.</sub></div>
