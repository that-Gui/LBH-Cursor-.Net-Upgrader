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
| `WORK_DIR` | no | `./work` | Nested clones (`repos/`), run state (`runs/`), finalize logs (`logs/<repo>.log`) |
| `BATCH_SIZE` | no | `4` | Repositories upgraded per `run` |
| `ACTIVE_MONTHS` | no | `12` | Repositories pushed within this window count as active |
| `CODE_OWNERS` | no | `0` | `0` scans the whole org; any other value scans only repos whose `CODEOWNERS` names that owner |

`WORK_DIR` must be a directory of its own (not cwd, `$HOME`, or `/`). **Set it.** The `./work` default puts the clones inside this repository — the same directory that holds `.env` — and the isolation note below is that a subagent can read any `.env` above `WORK_DIR`. The default therefore contradicts that advice, and only an override outside this checkout satisfies it.

```sh
export GITHUB_TOKEN=$(op read op://vault/dotnet10-upgrader/token)
export WORK_DIR=~/.local/state/dotnet10-upgrader
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
- `complete-run` — after the Cursor loop writes a finalizable `result.json`, advance `prepared` → `loop-complete`. Local file work under `WORK_DIR` only: it needs neither `GITHUB_ORG` nor `GITHUB_TOKEN`.
- `finalize` — restore Git config, apply gates, commit, push, open or adopt a PR. Exits non-zero when no PR is opened.
- `check` — `tsc --noEmit` plus the Node test runner.

Every subcommand takes `--help` (or `-h`): `npm run finalize -- --help` prints the usage and the environment reference on stdout and exits 0 without reaching GitHub. A rejected environment prints the same reference under the message it failed on — `missing required env var GITHUB_ORG` — rather than a stack trace, which is kept for unexpected errors.

There is no helper that starts the agent loop.

## What gets queued

Only `needs-upgrade` on complete evidence reaches the write path. A scan is incomplete when the git tree was truncated or project files exceed fetch caps (30 files, 1 MB each). Every other classification is reported as an exclusion, one line each under the queue, `(none)` when the category is empty, so a scanned repository's absence always has a stated reason:

```text
Excluded — .NET Framework: legacy-web
Excluded — netstandard-only: shared-lib
Excluded — no .NET project found: docs-site
Excluded — already on .NET 10 or later: already-ten
Excluded — incomplete scan: (none)
```

`CODE_OWNERS` matches per owner entry on `CODEOWNERS`, `.github/CODEOWNERS`, or `docs/CODEOWNERS` (leading `@` optional, case-insensitive). Filtered or unreadable CODEOWNERS repos leave the inventory entirely.

## What opens a PR

A PR opens only when `result.json` is finalizable (`schemaVersion` 1, `reviewers` PASS, `upgradeResult` SUCCESS, `buildPassed`, no test regression, empty `unresolvedCriticals`, no `critical` finding filed under `warnings`, `rounds` between 1 and 50, a non-empty `testsRun`, every carried baseline failure named, identity matching the manifest) **and** Git gates pass: HEAD still on the upgrade branch, HEAD still *at* the manifest's `baseSha`, at least one staged non-artifact change, nothing staged under `.github/`, `.claude/`, `.cursor/`, `.ssh/`, `.gitattributes`, `.gitmodules`, `.npmrc`, `.netrc`, `.envrc`, or `.env*`. A refusal names the field or the file it failed on, leaves the local clone where it is, and unstages whatever it staged to run the scans.

Every finalize that gets as far as reading the run manifest writes a redacted log to `WORK_DIR/logs/<repo>.log` and names it in the `logPath` of the JSON outcome — on refusal and on success alike. A failure earlier than that has no repo name to file the log under, so it reports its reason on stdout only.

The `baseSha` check is what makes the rest of the list mean anything. Every gate below reads `git diff --cached`, HEAD against the index, while the push sends the whole branch; those are the same change only while HEAD is still the commit the run was prepared at. A commit the loop made on the branch would ride into the PR unscanned, so finalize refuses it and tells the operator to move it back into the working tree.

Three staged-diff gates keep the PR to the retarget. Nothing added may silence a warning (`NoWarn`, `#pragma warning disable`, `WarningsNotAsErrors`, `TreatWarningsAsErrors` set false, `NuGetAudit*`). Every package reference the base branch did not have needs `evidence` in the writer's `packageDecisions` — the restore or build error the upgrade cannot pass without it. And no test may be deleted, stripped of its `[Fact]` / `[Theory]` / `[Test]` / `[TestMethod]` / `[TestCase` attribute, or switched off with `Skip =`, `[Ignore]`, `[Explicit]`, `Assert.Inconclusive`, or `Assert.Pass`, unless a `testChanges` entry names that file and says why the upgrade changed the behaviour it asserted. All three read the diff rather than the agent's report, and all three run before any of them refuses, so one finalize reports every violation it found — `refusing to open a PR, 2 gate violation(s): [1] … [2] …` — each naming the offending file. A newly added project's own references are the one exception the package gate makes: a project the base branch does not have must declare its dependencies, so demanding a build error for each would only teach the writer to invent the field. They are listed in the PR body under "References declared by project files this PR adds" for a human to read instead.

The writer records a pre-edit `dotnet build` / `dotnet test` baseline. Tests that were already red may stay red; a newly failing test blocks the PR. A test that stops *running* is the case the third gate exists for: it never shows up as a failure, so only the diff can catch it.

`complete-run` refuses to advance a run until it has *read* the round logs, not merely found them. Neither the parent nor the reviewers may run `dotnet` — it writes `bin/` and `obj/` into the clone under review — so `round-N-build.log` and `round-N-test.log`, for the N the result's `rounds` names, are the only mechanical evidence that the final round actually built and tested what is now on disk. Each has to be a regular file with content: a directory, a symlink pointing at a green log elsewhere, or an empty file is a refusal. The build log has to carry a `Build succeeded` verdict and no failure line, and the test log a verdict (`Passed!`, `Failed!`, `Test Run Successful.`, `Test Run Failed.`) or a `Failed: N` count whose total is no larger than the run's `baselineFailures`. A failed build, or failures above the baseline, refuses the run rather than warning about it.

`complete-run` records the sha256 of the `result.json` and of the round logs it gated on in the run manifest, and `finalize` — minutes later, in another process — re-reads the logs, re-runs the whole check rather than trusting the recorded phase, and re-hashes both. A `result.json` that grows a `testChanges` or `packageDecisions` entry after the only review the run gets, or a log swapped green behind the gate, refuses the PR and asks for `complete-run` again.

The PR body carries a dependency and package reasoning section: every version, target-framework, SDK, and base-image change is read from the staged diff, then joined by package id to the writer's recorded reason for the bump, so a reviewer sees why each old version could not stay and why that replacement was chosen. New references are listed again on their own with the evidence that required them, and recorded reasons with no matching change in the diff are listed separately rather than dropped. Any test whose asserted behaviour the upgrade changed is listed in the run summary with the reason given for it.

On GitHub 422 (branch already has a PR), finalize adopts the existing open PR.

## What stays out of the upgrade

A retarget PR that also bumps a package nothing forced, pulls in a package the project does not need, or silences a warning that was already firing spends reviewing time on changes the upgrade did not require. The playbook, the writer, and both reviewers say so in the same terms: a package version moves only where the retarget forces it, no reference the repository did not already have is added without a build error proving it necessary, and pre-existing warnings and vulnerability advisories are left alone and reported as residual risks rather than fixed or suppressed here.

Deleting or skipping a test is out for a different reason. It is not noise but a hole in the evidence the loop runs on: the loop decides whether the upgrade worked by comparing test results against the baseline, so a test that no longer runs makes that comparison lie. A test may therefore change only where the upgrade genuinely changes the behaviour it asserts, and the change has to be recorded to survive the gate.

Whether a given bump was forced is a judgement rather than a pattern, so that one belongs to the reviewers: the adversarial reviewer treats an unforced bump — including one motivated only by an advisory against the version already on the base branch — as a critical finding, and it hunts weakened, deleted, and skipped tests on the same terms. No PR opens while a critical is unresolved.

None of that makes scope a mechanical guarantee, and the PR body says as much. Finalize stages the whole working tree with `git add -A`, so a scratch file the loop left behind, or an edit to code the upgrade never needed to touch, is committed and pushed along with the retarget: the gates look for suppressions, unexplained references and weakened tests, and for nothing else. The same goes for a test that keeps its `[Fact]` and loses its assertions — deliberately not detected, because a removed-assert pattern fires on every legitimate refactor. Scope is judged by the reviewers and by whoever reads the diff.

## Isolation

The GitHub token lives only in the TypeScript helpers. Subagents are spawned without `GITHUB_TOKEN` (withheld by name for known aliases, and by value under any variable name). Helpers ignore system/global Git config and inherited `GIT_*` (including `GIT_DIR`), disable hooks, keep credentials off argv and disk, and attach the credential only on clone and push. After the loop, finalize restores the pristine `.git/config` and deletes `.git/hooks` before any further Git call.

That does **not** cover same-uid process isolation. Subagents can still read the parent environment, `~/.git-credentials`, `~/.netrc`, and any `.env` above `WORK_DIR`. Use a container or dedicated uid if the org's repositories are not all trusted.

All of `work/` is gitignored, so a `git add` from the upgrader root can never record a nested clone as a mode `160000` gitlink. Agents do not need the clones tracked here: they address them by absolute `TARGET_REPO_PATH`, and mutating Git is always `cwd` / `git -C` against the target clone. If Cursor cannot index `work/repos/<name>`, add it as a multi-root workspace folder for that run.

No agent may mutate a repository through the terminal. Cursor agent frontmatter cannot deny individual commands, so [`.cursor/hooks.json`](.cursor/hooks.json) registers a fail-closed `beforeShellExecution` hook that blocks `commit`, `push`, `reset`, `revert`, `checkout`, `switch`, `restore`, `stash`, `rebase`, `add`, and the rest of Git's state-changing subcommands, while leaving `status`, `diff`, `log`, `show`, `rev-parse`, and `ls-files` — everything the loop actually inspects — alone. It matches the subcommand token rather than a substring, so a read like `git diff "$BASELINE_SHA" -- src/ResetPassword.cs` still runs, and the read-only forms of the writing subcommands (`stash list`, `tag --list`, `worktree list`, `--help`) go through too. It splits on shell operators so a chained `git diff && git commit` cannot slip past, it re-parses the argument of a wrapping `sh -c` or `bash -lc` (clustered flags included) and of an `eval` string, it looks behind a wrapper such as `env`, `sudo`, `xargs` or `timeout`, it refuses a one-shot `-c alias.*` — which would otherwise run a subcommand whose name appears nowhere on the line — and it denies rather than guesses when an expansion could be hiding a subcommand name. Its matcher is `""`, which fires on every command, because a matcher that looked for the word `git` would never be consulted for `git<TAB>commit` or `$(which git) commit`; the script allows all read-only git and all non-git lines, so matching everything costs one 5-second-bounded process spawn. The helpers are deliberately outside it: they call Git in-process through `spawnSync` with `shell: false`, not through the agent's shell, so `prepare-repo` and `finalize` still clone, branch, commit, push, and open the PR. The writer and both reviewers are told the same rule in prose, because a hook sees the command an agent runs but not what that command goes on to execute: any interpreter is a pass-through, so `sh push.sh`, `make push`, and `node -e` are allowed and can still reach Git, as can a config file the agent plants and then points Git at, and nothing static can prevent either. That limitation is accepted and recorded in the script itself. What the hook guarantees is that direct and accidental shell mutation stops here — it is a guardrail, not a sandbox against an agent that sets out to work around it.

## Local verification

`npm run check` covers inventory classification, queue slices, run-state, Git isolation, PR-body fencing, Cursor skill/agent contracts, the Git hook's allow and deny decisions, and finalize against local bare remotes. Those tests never call GitHub.

The hook tests are the ones worth knowing about. They run the real script the way Cursor does — payload on stdin, decision on stdout, through the `.sh` wrapper and through a symlinked path — over the spellings a mutation arrives in: chained, quoted, `bash -lc`, `eval`, behind a wrapper, through an inline `alias.*`, and hidden by an expansion. On the allow side they replay the read-only forms, the list forms (`git stash list`, `git tag`, `git submodule status`), `git commit --help`, and every `git -C "$TARGET_REPO_PATH"` command extracted from `.cursor/`, so a prompt edit that introduces a command the guardrail would block fails the suite rather than stalling a run.

What those tests pin is the decision the hook returns for a command line. They cannot pin what the command line goes on to do, and they do not try: the interpreter pass-throughs above are allowed by design. Read a green suite as evidence the guardrail is not silently broken, not as evidence that an agent cannot push.
