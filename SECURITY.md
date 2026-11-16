# Security policy

## What this is

`repos-and-agents` is a **Herdr layout package**: 17 JavaScript mods that run inside the Herdr
desktop app with the privileges of the user who installed them. They can start programs (`git`,
`gh`, `hc`, `sqlite3`, the agent you pick, a dev server), read files in your home (agent stores,
git config, the app's own state) and use your `gh` credentials. That is what Herdr mods are;
there is no sandbox to report a bypass for.

Read `mods/*/main.js` before copying them into `~/.config/herdr-app`. There is no build step, no
dependency and nothing minified, so what you read is what runs.

## What is in scope

Reports are welcome for anything that lets someone who is **not** already running code as you
influence the package:

- **Anyone who can open an issue or a pull request** on a repository you have checked out. They
  control the title, labels, branch name, author and markdown body, and all of those are shown.
  In scope: making a panel fetch something, run something, open something, hide something, or
  write outside its own state.
- **A crafted repository** you clone or fetch: branch names, remotes, `package.json` scripts,
  worktree layout.
- **A hostile value in Herdr's shared state or `localStorage`** that changes where a mod reads,
  writes or sends.
- Anything that lets the package escalate beyond your own account.

## What is not in scope

- Another mod, or another process of yours, editing `~/.config/herdr-app` or its state. Any mod
  can do that by design; it is the same trust domain.
- The agent you ask it to start doing something. That is the agent's policy, not this package's.
- The endpoints you configure: `space-git`'s `HERDR_AI_BASE` and the title generator's provider
  (OMP's configured model, or `opencode.ai` when `OPENCODE_GO_API_KEY` is set). They are yours;
  the package only sends the text described below.
- Herdr itself. Report those to the Herdr project.

## How the mods are hardened

| | |
|---|---|
| Git reads | `--no-optional-locks -c core.fsmonitor=false -c diff.autoRefreshIndex=false`, so a read never writes under `.git` (`gh-git`, `spaces-tree`, `tabs-gh`, `space-git`, `worktree-gh`) |
| Branch and worktree names | `git check-ref-format --branch`, `--` before every positional, `.`/`..` and dot-runs removed by the name slug, the target path kept under the repos root (`gh-create`, `gh-new`, `spaces-tree`, `worktree-gh`) |
| Issue and PR text | control and bidi codepoints stripped; raw HTML and `<img>` removed before rendering; bodies capped; links open only on a click, only through Herdr's opener |
| Names on screen | space, repo, branch, agent and generated thread titles have bidi overrides and control characters stripped before they are drawn (`tabs-gh`, `wall-tile`, `spaces-tree`, `title-text`) |
| Title generation | only the last eight prompts, the folder, the previous title and the latest recap are sent; the reply is parsed, stripped of control/bidi characters and capped before it reaches shared state; one request at a time; no terminal output, diff or file contents |
| Paths from state | `repos.root` is checked to be a plain absolute path with no `.`/`..` component before anything reads or creates under it (`settings`, `space-new`, `worktree-gh`) |
| Repo scanning | only subdirectories with a `.git` entry are read; a folder git says is no repo is not asked again for a minute |
| Git ignored | `git` runs with the folder as `cwd` and never with `-c` from the repository's own config for the diff it sends |
| The AI call | the diff leaves the machine only when you press Draft, only to `HERDR_AI_BASE`, and only the paths you picked (`space-git`); the base URL is never written into the source |
| State | `localStorage` and shared values are parsed defensively; a corrupt value falls back to a default instead of taking the window's chrome down |

The reviewer's model: single-user desktop, attacker = whoever can write an issue body, a branch
name or a `package.json`. Everything else is out of scope.

## Reporting

Open an issue on this repository, or use GitHub's private vulnerability reporting for anything
you would rather not post publicly.
