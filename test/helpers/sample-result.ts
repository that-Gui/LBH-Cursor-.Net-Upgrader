import type { DependencyChanges } from "../../src/packages";
import { emptyDependencyChanges } from "../../src/packages";
import type { RunManifest, RunPhase, UpgradeResult } from "../../src/upgrade";

export function sampleDependencies(partial: Partial<DependencyChanges> = {}): DependencyChanges {
  return { ...emptyDependencyChanges(), ...partial };
}

export function sampleResult(partial: Partial<UpgradeResult> = {}): UpgradeResult {
  return {
    schemaVersion: 1,
    repo: "My.Repo-1_x",
    branch: "chore/dotnet10-upgrade-20260101-120",
    baseSha: "abc123def456",
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
    ...partial,
  };
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
    baseSha: "abc123def456",
    cloneUrl: "https://github.com/LBHackney/My.Repo-1_x.git",
    createdAt: "2026-01-01T12:00:00.000Z",
    ...partial,
  };
}
