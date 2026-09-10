---
name: dotnet10-upgrader
description: Inventories a GitHub org for pre-.NET 10 repos and, when explicitly invoked with run, upgrades a batch via the Cursor implementation loop and guarded finalize helpers. Use only when explicitly invoked.
disable-model-invocation: true
icon: rocket
color: blue
---

# .NET 10 upgrader

You are the parent agent for an organization batch. Helpers in this repository do
inventory, select, prepare, complete, and finalize. You drive
[engineering-implementation-loop](../engineering-implementation-loop/SKILL.md)
against each prepared clone. You do not write upgrade diffs yourself.

**Use only when explicitly invoked.** Pin **Custom Mode** and send with **Option+Enter**
(multi-turn) so a `/dotnet10-upgrader run` can complete unattended across rounds.

## Operator invoke

```text
/dotnet10-upgrader inventory
/dotnet10-upgrader run
```

If the argument is missing or neither of those, stop and say so. Do not infer `run`.

## Rules

- **Unattended once `run` starts.** No mid-loop questions. No extra confirmation
  between repos. A failed repo does not stop later repos.
- Helper commands (`npm run inventory`, `select`, `prepare-repo`, `complete-run`, `finalize`) run with
  **cwd = this upgrader repo root**. They load `.env` via the npm scripts. Do not
  pass `GITHUB_TOKEN` on the argv.
- Implementation-loop git/build/test runs with **cwd = `TARGET_REPO_PATH`** and
  `git -C "$TARGET_REPO_PATH"`. Never git/dotnet the upgrader root.
- Never put `GITHUB_TOKEN` in audit output, `result.json`, PR text you draft, or
  chat. Helpers redact; you still must not echo secrets. Writer/reviewers must not
  echo secrets.
- This skill may `npm run finalize` after a successful loop. The generic loop itself
  never commits or pushes.

Playbook (verbatim original request for every loop handoff):
[references/playbook.md](references/playbook.md)

Result and audit shape: [references/result-schema.md](references/result-schema.md)

## Playbook (pass verbatim)

Upgrade this repository to .NET 10 (LTS).
- FIRST, before you edit anything: run 'dotnet build', then 'dotnet test', on the repository exactly as you found it, and record the fully-qualified name of every failing test. That is the BASELINE. Capture it before your first edit — do not reconstruct it afterwards by stashing your changes.
- Update global.json (if present) and every <TargetFramework>/<TargetFrameworks> value to net10.0, preserving OS-specific suffixes (e.g. net8.0-windows becomes net10.0-windows).
- Update NuGet package references to stable versions compatible with net10.0.
- Report 'package_decisions': one entry for every package version you change and none for any package you do not, each giving the old version, the new version, why the old version could not stay, and why you picked that specific new version (stable, net10.0-compatible, lowest viable bump).
- Fix any resulting build or test breaks, including Dockerfile base images and SDK version pins.
- 'dotnet build' must pass. Then re-run 'dotnet test': every test still failing must already be in the baseline. A test that passed in the baseline and fails now is a regression — fix it. Tests that were already failing may stay failing.
- If the baseline build did not succeed there is no usable baseline, and the strict bar applies instead: both 'dotnet build' and 'dotnet test' must pass outright.
- Make no changes unrelated to the upgrade.
- In your summary, name every baseline failure you are carrying forward and why it fails, so a human can check the claim against the base branch.
- End your final summary with exactly these three lines, in this order, with nothing after them:
BASELINE_FAILURES: <how many baseline failures are still failing; 0 if none>
REVIEWERS: PASS (only if both reviewers returned PASS with zero Criticals) or REVIEWERS: FAIL otherwise
UPGRADE_RESULT: SUCCESS (only if the build passes and no test regressed against the baseline) or UPGRADE_RESULT: FAILED otherwise

## `/dotnet10-upgrader inventory`

1. From the upgrader root: `npm run inventory` (equivalent: `tsx src/main.ts inventory`).
2. Print the helper's queue to the user.
3. **Do not** clone, commit, push, or open a PR. Stop.

## `/dotnet10-upgrader run`

Load config from the environment the helpers already read (`GITHUB_ORG`, `GITHUB_TOKEN`,
`WORK_DIR` default `./work`, `BATCH_SIZE` default `4`, `ACTIVE_MONTHS`, optional
`CODE_OWNERS`). Do not print the token.

### 1. Select the batch

```bash
npm run select
```

Expect JSON for the first `BATCH_SIZE` `needs-upgrade` repos. If the batch is empty,
report that and stop. Do not clone.

### 2. For each repo sequentially

Failure of one repo does not stop later repos. For each:

#### a. Prepare

```bash
npm run prepare-repo -- --repo NAME
```

(`prepare-repo` is the npm script; the CLI subcommand is `prepare`.)

Capture the JSON manifest: `cloneDir`, `runId`, `upgradeBranch`, `baseSha`.
If prepare fails, record the reason, skip finalize, continue the batch.

Set:

- `TARGET_REPO_PATH` = absolute `cloneDir`
- `RUN_ID` = `runId`
- `RUN_DIR` = `$WORK_DIR/runs/<runId>/` (resolve `WORK_DIR` the same way as the helper)
- `BASELINE_SHA` = `baseSha`

#### b. Drive the implementation loop

Follow [engineering-implementation-loop](../engineering-implementation-loop/SKILL.md)
in this same parent turn. You are that parent.

- Original request = the playbook above, verbatim.
- `TARGET_REPO_PATH`, `RUN_ID`, `RUN_DIR`, `BASELINE_SHA` as set.
- Stage 0: require a **clean** clone; if dirty, skip to result `FAILED` and continue the batch.
- Launch subagents with the **Task** tool (never resume the writer):

| Stage | `subagent_type` |
| :--- | :--- |
| Writer, each round, fresh Task | `lbh-dotnet10-implementation-agent` |
| Reviewers, both in **one** message after the writer | `lbh-dotnet10-adversarial-reviewer` |
| | `lbh-dotnet10-architectural-reviewer` |

Four rounds hard; stop early if one critical survives three rounds.

#### c. Write `result.json` and `audit.md`

Path: `$WORK_DIR/runs/<runId>/result.json` (`schemaVersion` 1) and `audit.md`.
Fields and finalize gate: [references/result-schema.md](references/result-schema.md).

Derive `reviewers` / `upgradeResult` from the loop (both reviewers `PASS` with zero
criticals; build passed; no test regression). Do not trust a writer trailer that
conflicts with the ledger or logs.

Copy the last writer round's `package_decisions` into `packageDecisions` verbatim — the
PR body joins those reasons to a version-change table read straight from the diff. Do not
write reasons the writer did not give, and do not drop entries you cannot match to the
diff; finalize surfaces unmatched ones rather than hiding them. If a .NET 10 run changed
package versions and the writer reported none, note that in the audit.

#### d. Finalize or leave local

**Only if** `reviewers` is `PASS` **and** `upgradeResult` is `SUCCESS` **and**
`buildPassed` **and** `testsRegressed` is false **and** there are no unresolved
criticals:

```bash
npm run complete-run -- --run-id RUN_ID
npm run finalize -- --run-id RUN_ID
```

`complete-run` (CLI `complete`) advances the run from `prepared` to `loop-complete`
after validating `result.json`. `finalize` refuses any other phase.

Otherwise leave the local clone and logs, record the reason in the audit and the
batch summary, and continue.

#### e. Capture finalize outcome

If finalize ran, record the PR URL (or the helper's failure reason). Do not retry
commit/push yourself.

### 3. Final aggregate report

When the batch ends, this report **replaces process exit code**. Include:

- PR URLs for repos that finalized
- Failed repos and reasons (prepare, dirty clone, loop blocked, review fail, upgrade
  fail, finalize gate)
- Paths to each `audit.md` / `result.json`
- `ok` count vs `selected` count

Do not dump secrets or raw `.env`.

## How the parent launches subagents

Use the Task tool from this parent. Do not implement the upgrade or perform reviews
in the parent.

**Writer (every round):** new Task, `subagent_type: lbh-dotnet10-implementation-agent`,
`run_in_background: false`. **Do not pass `resume`.** Prompt = ordered handoff from
the loop skill (original playbook, `TARGET_REPO_PATH`, `RUN_ID`, `RUN_DIR`,
`BASELINE_SHA`, `BASELINE_RESULTS`, ledger, findings, required output).

**Reviewers (after the writer finishes):** two Task calls in the **same** parent
message, `lbh-dotnet10-adversarial-reviewer` and `lbh-dotnet10-architectural-reviewer`,
both `run_in_background: false`. Instruct them **not** to run `dotnet build` / `dotnet test`.
Give log paths under `RUN_DIR` and `git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA"`.
