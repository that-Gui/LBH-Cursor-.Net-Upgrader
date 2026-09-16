import fs from "node:fs";
import path from "node:path";
import type { DependencyChanges } from "../../src/packages";
import { emptyDependencyChanges } from "../../src/packages";
import { roundBuildLogName, roundTestLogName } from "../../src/upgrade";
import type { RunManifest, RunPhase, UpgradeResult } from "../../src/upgrade";

/** `dotnet build` output as the terminal logger really writes it, trimmed to the verdict. */
export const PASSING_BUILD_LOG = [
  "  Determining projects to restore...",
  "  Restored /work/src/App.Api/App.Api.csproj (in 412 ms).",
  "  App.Domain -> /work/src/App.Domain/bin/Debug/net10.0/App.Domain.dll",
  "",
  "Build succeeded.",
  "    0 Warning(s)",
  "    0 Error(s)",
  "",
  "Time Elapsed 00:00:04.21",
  "",
].join("\n");

/** `dotnet test` output, including the banner line the gate reads the failure count from. */
export function passingTestLog(failed = 0, passed = 12): string {
  const verdict = failed === 0 ? "Passed!" : "Failed!";
  return [
    `Test run for /work/tests/App.Tests/bin/Debug/net10.0/App.Tests.dll (.NETCoreApp,Version=v10.0)`,
    "VSTest version 18.0.0 (x64)",
    "",
    "Starting test execution, please wait...",
    "A total of 1 test files matched the specified pattern.",
    "",
    `${verdict}  - Failed:     ${failed}, Passed:    ${passed}, Skipped:     0, Total:    ${failed + passed}, Duration: 42 ms`,
    "",
  ].join("\n");
}

/** The evidence the round-log gate reads, for the round a result claims. */
export function writeRoundLogs(
  dir: string,
  rounds = 1,
  logs: { build?: string; test?: string } = {},
): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, roundBuildLogName(rounds)), logs.build ?? PASSING_BUILD_LOG);
  fs.writeFileSync(path.join(dir, roundTestLogName(rounds)), logs.test ?? passingTestLog());
}

export function sampleDependencies(partial: Partial<DependencyChanges> = {}): DependencyChanges {
  return { ...emptyDependencyChanges(), ...partial };
}

/** A real `git rev-parse HEAD` is 40 hex characters; a 12-character stub exercises no path. */
export const SAMPLE_BASE_SHA = "9f1c2d3e4a5b60718293a4b5c6d7e8f901234567";

export function sampleResult(partial: Partial<UpgradeResult> = {}): UpgradeResult {
  return {
    schemaVersion: 1,
    repo: "My.Repo-1_x",
    branch: "chore/dotnet10-upgrade-20260101-120",
    baseSha: SAMPLE_BASE_SHA,
    baselineFailures: 0,
    baselineFailureNames: [],
    buildPassed: true,
    testsRegressed: false,
    reviewers: "PASS",
    upgradeResult: "SUCCESS",
    rounds: 1,
    unresolvedCriticals: [],
    warnings: [],
    implementationSummary: "Moved TFMs to net10.0.",
    testsRun: ["dotnet build — passed", "dotnet test — passed"],
    residualRisks: [],
    packageDecisions: [],
    testChanges: [],
    ...partial,
  };
}

/**
 * A result with every array populated and every string long enough to notice. `sampleResult`
 * is deliberately minimal, which makes it a weak round-trip subject: a parser that dropped the
 * contents of `residualRisks` or of a `Finding`'s optional fields would still satisfy a
 * deepEqual against empty arrays and one-line strings.
 */
export function populatedResult(partial: Partial<UpgradeResult> = {}): UpgradeResult {
  return sampleResult({
    baselineFailures: 3,
    baselineFailureNames: [
      "App.Tests.LedgerTests.Balances",
      "App.Tests.AccountScenarios.Adds",
      "App.Integration.Tests.SmokeTests.Boots",
    ],
    rounds: 4,
    warnings: [
      {
        severity: "warning",
        title: "Serilog 2.12.0 has a moderate advisory that already applied on the base branch",
        file: "src/App.Api/App.Api.csproj",
        line: "14",
        evidence: "round-4-build.log line 38: NU1902",
        impact: "no change in exposure; the advisory predates this upgrade",
        recommendation: "raise separately so the retarget stays reviewable",
      },
      { severity: "suggestion", title: "consider central package management once the retarget lands" },
    ],
    implementationSummary: [
      "Retargeted all four projects to net10.0, bumped the SDK pin in global.json and the two",
      "Dockerfile stages, then fixed the CS8600 nullability breaks the new analyzers surfaced.",
    ].join("\n"),
    testsRun: [
      "dotnet build App.sln — succeeded, 0 errors, 7 warnings",
      "dotnet test tests/App.Tests — Passed! 118 passed, 3 failed (all baseline)",
      "dotnet test tests/App.Integration.Tests — Passed! 22 passed",
    ],
    residualRisks: [
      "The Dockerfile aspnet base image moved to 10.0 but no container smoke test runs in CI.",
      "Serilog stays on 2.12.0; its net10.0 assets are untested in this repository.",
    ],
    packageDecisions: [
      {
        package: "Microsoft.EntityFrameworkCore",
        from: "8.0.4",
        to: "10.0.0",
        reason: "8.0.4 has no net10.0-compatible assets",
        evidence: "round-2-build.log line 55: NETSDK1005",
      },
    ],
    testChanges: [
      {
        file: "tests/App.Tests/LedgerTests.cs",
        change: "Balances now asserts with the invariant culture",
        reason: "net10.0 ships different culture data and the assertion pinned the old output",
      },
    ],
    ...partial,
  });
}

export function sampleManifest(
  workDir: string,
  cloneDir: string,
  partial: Partial<RunManifest> = {},
): RunManifest {
  return {
    schemaVersion: 1,
    runId: "My.Repo-1_x-20260101-120",
    phase: "prepared" as RunPhase,
    org: "LBHackney",
    repo: "My.Repo-1_x",
    defaultBranch: "main",
    upgradeBranch: "chore/dotnet10-upgrade-20260101-120",
    cloneDir,
    workDir,
    baseSha: SAMPLE_BASE_SHA,
    cloneUrl: "https://github.com/LBHackney/My.Repo-1_x.git",
    createdAt: "2026-01-01T12:00:00.000Z",
    ...partial,
  };
}
