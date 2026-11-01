# Security policy

## What this is

`herdr-gh-board` is a **Herdr layout package**: four JavaScript mods that run inside the Herdr desktop app with the privileges of the user who installed them. They can start programs (`gh`, `git`, and the agent you pick), read files in your home, and use your `gh` credentials. That is what Herdr mods are; there is no sandbox to report a bypass for.

Please read `mods/*/main.js` before copying them into `~/.config/herdr-app`. There is no build step, no dependency and nothing minified, so what you read is what runs.

## What is in scope

Reports are welcome for anything that lets an attacker who is **not** already running code as you influence the package:

- **Anyone who can open an issue or pull request** on a repository you have checked out. They control the title, the labels and the markdown body, and those are displayed. In scope: making the panel fetch something, execute something, open something, hide something, or write outside its own state.
- **A crafted repository** you clone or fetch (branch names, remotes, worktree layout).
- **A hostile value in Herdr's shared state or `localStorage`** that changes where the package reads or writes.
- Anything that lets the package escalate beyond the user's own account.

## What is not in scope

- Another mod, or another process of yours, editing `~/.config/herdr-app` or the app's state. Any mod can do that by design; it is the same trust domain.
- The agent you ask it to start doing something. That is the agent's policy, not this package's.
- Herdr itself. Report those at the Herdr project.

## How this version was hardened

Reported and fixed in `v1.0.0`:

| | |
|---|---|
| Branch and worktree names | validated with `git check-ref-format --branch`; `--` before every positional; `.`/`..` and dot-runs removed by the name slug; the target path must stay under `~/.herdr/worktrees/` |
| Issue and PR text | control and bidi codepoints stripped; markdown images and raw HTML removed before rendering; descriptions capped at 4 kB; links open only on a click, only through Herdr's guarded opener, and only to `github.com` |
| Labels | may not impersonate the panel's own `draft` / `approved` / `changes requested` tags |
| `git init` | only when git itself says there is no repository here, never in `$HOME` or `/` |
| Scanning | a folder's subdirectories are read six at a time, and only where a `.git` entry exists |
| State | the per-space panel memory and the panel's filter are parsed defensively; a corrupt value falls back to a default instead of taking the window's chrome down |

The audit that produced this list is described in the repository history (commit `v1.0.0`); the reviewer's model is: single-user desktop, attacker = whoever can write an issue body or a branch name, everything else out of scope.

## Reporting

Open an issue (it shows up in the panel this package provides — if the repo is checked out in the folder you point it at). For anything you would rather not post publicly, use GitHub's private vulnerability reporting on this repository.
