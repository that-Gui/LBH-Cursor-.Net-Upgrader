```text
     _         _                  _    _   ___
  __| |  ___  | |_  _ __    ___  | |_ / | / _ \
 / _` | / _ \ | __|| '_ \  / _ \ | __|| || | | |
| (_| || (_) || |_ | | | ||  __/ | |_ | || |_| |
 \__,_| \___/  \__||_| |_| \___/  \__||_| \___/  -upgrader

  org-wide .NET 10 (LTS) upgrades, one reviewed PR at a time
  Cursor-only — TypeScript helpers; implementation and review via skills/subagents
```

# dotnet10-upgrader

Cursor flavour of [orgDotnetUpgrade](https://github.com/that-Gui/orgDotnetUpgrade) (pinned `8bf211a3fde5437106d0c934dc4829daedbe670f`). Writer/reviewer loop skills are adapted from [LBH-Cursor-ImplementationLoop](https://github.com/that-Gui/LBH-Cursor-ImplementationLoop) (`5a520da9d771d5f676437948f220bf740990af5d`). Inventories a GitHub org for projects targeting modern .NET below 10, upgrades a small sequential batch to .NET 10 (LTS), and opens pull requests. TypeScript helpers own inventory, clone/branch handling, security gates, and PR creation. **Cursor skills and subagents** (under `.cursor/`) own implementation, review, and retry. **Humans remain the merge gate.**

Open this repository in Cursor and invoke:

```text
/dotnet10-upgrader inventory
/dotnet10-upgrader run
```

`inventory` is read-only. `run` selects the first `BATCH_SIZE` `needs-upgrade` repositories and, one at a time, prepares a clone, drives the Cursor loop, then finalizes a PR or leaves a local log. Pin `/dotnet10-upgrader` as a Custom Mode with `Option`+`Enter` (macOS) or `Alt`+`Enter` (Windows) for a multi-turn run.

## Prerequisites

- `git` on PATH, Node.js **>= 24.18**, .NET 10 SDK (plus any SDKs the targets currently pin).
- Cursor, with this repository opened so `.cursor/` skills and agents load.
- A GitHub token (fine-grained PAT or GitHub App installation token) scoped to this org with **contents: read/write** and **pull-requests: write**. Do **not** use `gh auth token`.

## Configuration

Copy [`.env.example`](.env.example) to `.env` at the repository root. `.env` is gitignored. A real environment variable always wins over the file of the same name.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `GITHUB_ORG` | yes | — | Organization to scan |
| `GITHUB_TOKEN` | yes | — | Auth for API, clone, and push |
| `WORK_DIR` | no | `./work` | Nested clones (`repos/`), run state (`runs/`), logs (`logs/`) |
| `BATCH_SIZE` | no | `4` | Repositories upgraded per `run` |
| `ACTIVE_MONTHS` | no | `12` | Repositories pushed within this window count as active |
| `CODE_OWNERS` | no | `0` | `0` scans the whole org; any other value scans only repos whose `CODEOWNERS` names that owner |

`WORK_DIR` must be a directory of its own (not cwd, `$HOME`, or `/`). Prefer a `WORK_DIR` outside the directory that holds `.env`.

```sh
export GITHUB_TOKEN=$(op read op://vault/dotnet10-upgrader/token)
```

## Helper scripts

Helpers are deterministic TypeScript. The Cursor parent invokes them; you can also run them directly.

```sh
npm install

npm run inventory
npm run select
npm run prepare-repo -- --repo NAME
npm run complete-run -- --run-id ID
npm run finalize -- --run-id ID

npm run check
```

- `inventory` — human-readable upgrade queue.
- `select` — first `BATCH_SIZE` `needs-upgrade` reports as JSON.
- `prepare-repo` — shallow-clone the default branch into `WORK_DIR/repos/NAME`, create `chore/dotnet10-upgrade-<stamp>`, write a run manifest.
- `complete-run` — after the Cursor loop writes a finalizable `result.json`, advance `prepared` → `loop-complete`.
- `finalize` — restore Git config, apply gates, commit, push, open or adopt a PR. Exits non-zero when no PR is opened.
- `check` — `tsc --noEmit` plus the Node test runner.

There is no helper that starts the agent loop.

## What gets queued

Only `needs-upgrade` on complete evidence reaches the write path. A scan is incomplete when the git tree was truncated or project files exceed fetch caps (30 files, 1 MB each). `framework`, `netstandard-only`, `no-dotnet`, `up-to-date`, and `incomplete` are reported as exclusions.

`CODE_OWNERS` matches per owner entry on `CODEOWNERS`, `.github/CODEOWNERS`, or `docs/CODEOWNERS` (leading `@` optional, case-insensitive). Filtered or unreadable CODEOWNERS repos leave the inventory entirely.

## What opens a PR

A PR opens only when `result.json` is finalizable (`schemaVersion` 1, `reviewers` PASS, `upgradeResult` SUCCESS, `buildPassed`, no test regression, empty `unresolvedCriticals`, identity matching the manifest) **and** Git gates pass: HEAD still on the upgrade branch, at least one staged non-artifact change, nothing staged under `.github/`, `.claude/`, `.cursor/`, `.ssh/`, `.gitattributes`, `.gitmodules`, `.npmrc`, `.netrc`, `.envrc`, or `.env*`. Any failure leaves the local clone and a redacted log.

The writer records a pre-edit `dotnet build` / `dotnet test` baseline. Tests that were already red may stay red; a newly failing test blocks the PR.

The PR body carries a dependency and package reasoning section: every version, target-framework, SDK, and base-image change is read from the staged diff, then joined by package id to the writer's recorded reason for the bump, so a reviewer sees why each old version could not stay and why that replacement was chosen. Recorded reasons with no matching change in the diff are listed separately rather than dropped.

On GitHub 422 (branch already has a PR), finalize adopts the existing open PR.

## Isolation

The GitHub token lives only in the TypeScript helpers. Subagents are spawned without `GITHUB_TOKEN` (withheld by name for known aliases, and by value under any variable name). Helpers ignore system/global Git config and inherited `GIT_*` (including `GIT_DIR`), disable hooks, keep credentials off argv and disk, and attach the credential only on clone and push. After the loop, finalize restores the pristine `.git/config` and deletes `.git/hooks` before any further Git call.

That does **not** cover same-uid process isolation. Subagents can still read the parent environment, `~/.git-credentials`, `~/.netrc`, and any `.env` above `WORK_DIR`. Use a container or dedicated uid if the org's repositories are not all trusted.

`work/repos/` is **not** gitignored so Cursor can see nested clones. `work/runs/` and `work/logs/` **are**. Do not `git add` clones from the upgrader root; mutating Git is always `cwd` / `git -C` against the target clone. If Cursor cannot see `work/repos/<name>`, add it as a multi-root workspace folder for that run.

## Local verification

`npm run check` covers inventory classification, queue slices, run-state, Git isolation, PR-body fencing, Cursor skill/agent contracts, and finalize against local bare remotes. Those tests never call GitHub.
