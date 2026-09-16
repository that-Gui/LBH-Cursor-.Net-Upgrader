# Run result schema

Write `result.json` to `$WORK_DIR/runs/<runId>/result.json` with `schemaVersion: 1`.
Write `audit.md` next to it. Never include `GITHUB_TOKEN`, `.env` contents, clone URLs with credentials, or redacted secret material.

Helpers consume `result.json` during `npm run complete-run -- --run-id <runId>` then `npm run finalize -- --run-id <runId>`. The parent derives verdict fields from the loop ledger and recorded logs; do not copy the writer's PLAYBOOK trailer blindly if it disagrees with that evidence.

## Rename the writer's keys — `result.json` is camelCase

Writers and reviewers report in snake_case. `result.json` is camelCase, and the parser
matches key names exactly. **Rename the key on every copy**, then copy the value verbatim:

| Writer / reviewer field | `result.json` key |
| :--- | :--- |
| `package_decisions` | `packageDecisions` |
| `test_changes` | `testChanges` |
| `baseline_failure_names` | `baselineFailureNames` |
| `implementation_summary` | `implementationSummary` |
| `tests_run` | `testsRun` |
| `residual_risks` | `residualRisks` |

"Verbatim" applies to the **value** — the entries, their wording, their order. It never
means keeping the snake_case key.

Getting this wrong is mostly silent. `packageDecisions` and `testChanges` are optional, so
a leftover `package_decisions` key is dropped as unknown, both parse as `[]`, the result is
still `finalizable`, and the first sign of trouble is finalize refusing the pull request
with `refusing to open a PR, 1 gate violation(s): [1] weakens tests with no recorded
reason: …` for a change the writer did justify. Only `baselineFailureNames` fails loudly,
because it is required.

## `result.json`

```json
{
  "schemaVersion": 1,
  "repo": "<org repo name>",
  "branch": "<upgrade branch from prepare>",
  "baseSha": "<BASELINE_SHA / prepare baseSha>",
  "baselineFailures": 0,
  "baselineFailureNames": [],
  "buildPassed": true,
  "testsRegressed": false,
  "reviewers": "PASS",
  "upgradeResult": "SUCCESS",
  "rounds": 1,
  "unresolvedCriticals": [],
  "warnings": [],
  "implementationSummary": "<what changed and why>",
  "testsRun": ["dotnet build — passed", "dotnet test — passed"],
  "residualRisks": [],
  "packageDecisions": [
    {
      "package": "Microsoft.EntityFrameworkCore",
      "from": "8.0.4",
      "to": "10.0.0",
      "reason": "8.0.4 has no net10.0-compatible assets and failed to restore after the retarget; 10.0.0 is the lowest stable release that supports net10.0.",
      "evidence": "first stable release with a net10.0 target"
    }
  ],
  "testChanges": [
    {
      "file": "test/Ledger.Tests/BalanceTests.cs",
      "change": "Balances now asserts the invariant-culture format",
      "reason": "net10.0 ships different culture data, and the assertion pinned the old output"
    }
  ]
}
```

| Field | Type | Notes |
| :--- | :--- | :--- |
| `schemaVersion` | number | Always `1` (`RESULT_SCHEMA_VERSION`). |
| `repo` | string | Repository name from prepare/select. |
| `branch` | string | Upgrade branch (`upgradeBranch` from prepare). |
| `baseSha` | string | Clean clone `HEAD` at Stage 0. |
| `baselineFailures` | number | Count of baseline test failures still failing; `0` if none. It is also the ceiling the round test log is checked against, so a log reporting more failures than this refuses the run. |
| `baselineFailureNames` | string[] | Required, and `[]` when `baselineFailures` is `0`. Fully-qualified names of the carried-forward failures; a non-zero `baselineFailures` with an empty array is rejected, because a carried failure has to be named to be checkable on the base branch. Keep the two in agreement — the example above pairs `0` with `[]`. |
| `buildPassed` | boolean | Final `dotnet build` in the clone passed. |
| `testsRegressed` | boolean | A test that passed in the baseline now fails. If the baseline build failed, any remaining test failure is a regression against the strict bar. |
| `reviewers` | `"PASS"` \| `"FAIL"` | `PASS` only if both reviewers returned `PASS` with zero criticals. |
| `upgradeResult` | `"SUCCESS"` \| `"FAILED"` | `SUCCESS` only if `buildPassed` and `testsRegressed` is false. |
| `rounds` | number | Writer rounds actually dispatched, and the `N` in the `round-N-*.log` filenames the evidence gate reads. The loop caps this at 4; the parser only requires an integer `>= 0`, but `complete-run` and `finalize` reject anything outside **1-50**, because `rounds: 0` and `rounds: 1e21` name no round whose logs could be read. |
| `unresolvedCriticals` | Finding[] | Outstanding critical findings, or empty. Every entry needs `severity` and `title` — see [Finding entries](#finding-entries). |
| `warnings` | Finding[] | Non-blocking warnings and suggestions collected across reviews. Same entry shape, `severity` included — but an entry with `severity: "critical"` here is **rejected**: the gate's "zero criticals" reads `unresolvedCriticals`, so a critical filed under `warnings` would pass a check whose stated meaning is that there are none. File it where it belongs and resolve it. |
| `implementationSummary` | string | Loop Stage 4 summary. Truncate if huge; never include secrets. |
| `testsRun` | string[] | One line per command and actual result from writer logs. Strings only, and at least one: an empty array is rejected, because the build and test commands actually run have to be recorded. |
| `residualRisks` | string[] | Known limitations, carried baseline failures, follow-up work. One string per risk; an array of objects is rejected with `residualRisks must be an array of strings`. |
| `packageDecisions` | array | One entry per package version the writer changed, from its `package_decisions`. Optional in the schema (absent parses as `[]`, so `schemaVersion` stays `1`), but required output for a .NET 10 run. |
| `testChanges` | array | One entry per test whose asserted behaviour the upgrade changed. Optional in the schema (absent parses as `[]`, so `schemaVersion` stays `1`), and empty is the normal case: the upgrade should leave the suite alone. |

Every field above except `packageDecisions` and `testChanges` is required. A missing or
mistyped one throws `invalid upgrade result: <key> …` and `complete-run` refuses to
advance the run, so the failure is at least visible.

Two parser behaviours are not:

- **Unknown top-level keys are accepted and silently dropped.** A misspelling, or a
  leftover writer field such as `diff_stat`, does not fail validation — it just is not
  there afterwards. Nothing warns you.
- **A key repeated in the JSON text resolves last-wins**, because `JSON.parse` keeps the
  final occurrence. Two `"rounds"` lines validate, and the first value is gone.

Write the file once, from the table above, rather than appending to a draft.

### Finding entries

`unresolvedCriticals` and `warnings` hold the same object, straight from a reviewer's
output block. **`severity` is required on every entry in both arrays**, including entries
in `warnings` — the array a finding sits in does not imply its severity, and omitting the
field fails the whole run with `invalid upgrade result: warnings[0].severity is invalid`.

| Field | Type | Notes |
| :--- | :--- | :--- |
| `severity` | `"critical"` \| `"warning"` \| `"suggestion"` | Required, exactly one of those three strings. Anything else, including absent, is rejected. |
| `title` | string | Required. One line naming the defect. |
| `file` | string? | Path. Omit if unknown — `null` is rejected, only absence is allowed. |
| `line` | string? | **A string**, not a number: `"12"` or `"12-18"`. `"line": 12` is rejected with `line must be a string`. |
| `evidence` | string? | The code path and the input or condition that triggers it, or the log line. |
| `impact` | string? | What goes wrong at runtime, and for whom. |
| `recommendation` | string? | The specific change that fixes it. |

A run that the loop could not clear carries its findings through. Populated arrays look
like this:

```json
{
  "reviewers": "FAIL",
  "upgradeResult": "FAILED",
  "unresolvedCriticals": [
    {
      "severity": "critical",
      "title": "TargetFramework left at net8.0",
      "file": "src/Ledger.Api/Ledger.Api.csproj",
      "line": "4",
      "evidence": "round-4-build.log line 112: NETSDK1045 while the csproj still reads <TargetFramework>net8.0</TargetFramework>",
      "impact": "The API project never moves to .NET 10, so the upgrade is incomplete.",
      "recommendation": "Retarget the project to net10.0 and rerun the build."
    }
  ],
  "warnings": [
    {
      "severity": "warning",
      "title": "NU1903 advisory on Newtonsoft.Json 12.0.3 predates this change",
      "file": "src/Ledger.Api/Ledger.Api.csproj",
      "line": "17-19",
      "evidence": "round-4-build.log line 38; the same advisory fires on BASELINE_SHA."
    }
  ]
}
```

Those three fields move together: `unresolvedCriticals` being non-empty is one of the
conditions that blocks `complete-run`, and `reviewers` / `upgradeResult` must agree with it.

### `packageDecisions` entries

| Field | Type | Notes |
| :--- | :--- | :--- |
| `package` | string | NuGet package id exactly as it appears in the manifest. Rejected when empty or whitespace-only. |
| `from` | string? | Version before the change. Omit for a newly added reference. |
| `to` | string? | Version after the change. Omit for a removed reference. |
| `reason` | string | Required, and rejected when empty or whitespace-only. Why the old version could not stay **and** why that specific new version was chosen — stable, `net10.0`-compatible, lowest viable bump. |
| `evidence` | string? | What backs the choice, e.g. `"first stable release with a net10.0 target"` or the restore error the old version produced. |

The PR body joins these to a table of version changes derived independently from the git
diff. Record one entry for every package whose version changed, and none for packages that
did not change: an entry with no matching diff row is surfaced separately in the PR, and a
changed package with no entry leaves an unexplained row.

### `testChanges` entries

| Field | Type | Notes |
| :--- | :--- | :--- |
| `file` | string | Repo-relative path of the test file, exactly as it appears in the diff. Rejected when empty or whitespace-only. Matched after normalising `\` to `/`, collapsing repeated slashes, dropping a leading `./` or `/`, and lowercasing, so `.\Tests\Ledger//BalanceTests.cs` still matches `Tests/Ledger/BalanceTests.cs`. It still names one file: a bare basename such as `BalanceTests.cs` matches nothing unless the file really sits at the repository root, and a directory or partial path does not match either. |
| `change` | string | Required, and rejected when empty or whitespace-only. What changed about the test, e.g. `"Balances now asserts the invariant-culture format"`. |
| `reason` | string | Required, and rejected when empty or whitespace-only. Why the upgrade changed the behaviour the test asserted. A blank field is not a claim a reviewer can check, so the parser refuses it rather than letting the run look finalizable and fail at the pull request. |

Finalize reads the staged diff for tests that were deleted, unregistered (a removed `[Fact]`,
`[Theory]`, `[Test]`, `[TestMethod]`, `[TestCase`), or disabled (an added `Skip =`, `[Ignore]`,
`[Explicit]`, `Assert.Inconclusive`, `Assert.Pass`), and refuses the pull request when no entry
names that file with a non-empty reason. The entry is a reviewable claim, not a waiver: a
weakening you cannot justify in those terms must be reverted rather than recorded here.

`complete-run` / `finalize` are allowed only when all of these are true. A refusal names the
field that failed, so read the message rather than diffing this document against the file:

- `reviewers` is `PASS`
- `upgradeResult` is `SUCCESS`
- `buildPassed` is true
- `testsRegressed` is false
- `unresolvedCriticals` is empty, and no entry in `warnings` carries `severity: "critical"`
- `rounds` is an integer between 1 and 50
- `testsRun` is non-empty
- `baselineFailureNames` is non-empty whenever `baselineFailures` is greater than 0
- the round logs the run actually ends on pass the content check below

### The round-log contract

`round-$N-build.log` and `round-$N-test.log`, where `$N` is the `rounds` value in `result.json`,
are the only proof the final writer round built and tested: the parent cannot run `dotnet` itself
without writing `bin/` and `obj/` into the clone under review. Both are read, not merely listed.

- Each must be a **regular file with content** in the run directory. A directory, a symlink (to a
  green log elsewhere or to nothing), or a zero-length file is refused.
- The **build log** must match `Build succeeded` and must not carry a build-failed line.
- The **test log** must carry a verdict — `Passed!`, `Failed!`, `Test Run Successful.`,
  `Test Run Failed.` — or a `Failed: N` count. A failed run with no count to compare is refused.
- The **summed `Failed: N` counts must not exceed `baselineFailures`**. More failures than the run
  carries as baseline is a refusal, not a warning.

Redirect the real command output into them
(`dotnet build 2>&1 | tee $RUN_DIR/round-$N-build.log`) rather than composing them. The gate only
checks that a log reads like the output of a build or a test run; what a hand-written one would
still have to survive is the adversarial reviewer reading the same files against the diff.

`complete-run` records the sha256 of `result.json` and of those two logs in the run manifest, as
`resultDigest` and `roundLogsDigest`. `finalize` runs later in another process: it re-reads the
logs, re-runs this whole check rather than trusting the recorded phase, and compares both digests.
Editing `result.json` — appending a `testChanges` or `packageDecisions` entry, say — or swapping a
log after `complete-run` has passed refuses the pull request and sends the run back through
`complete-run`. Write the document and the logs once, before completing the run.

## `audit.md`

Redact anything that looks like a token. Include:

- Run identities: `repo`, `runId`, `branch`, `baseSha`, `TARGET_REPO_PATH`, `RUN_DIR`
- Stage 0 cleanliness check
- Writer round summaries (`implementation_summary`, `tests_run`, `triage_decisions`)
- Raw adversarial and architectural reviews (full text)
- Rejection ledger
- Paths to persisted `dotnet --info` / build / test logs
- Warnings and residual risks
- Finalize decision and reason (ran vs skipped)

Do not paste helper stdout that could contain clone URLs with embedded credentials.
