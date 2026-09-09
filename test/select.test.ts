import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { upgradeQueue, type RepoReport } from "../src/inventory";
import { loadConfig } from "../src/upgrade";
import { mockOctokit } from "./helpers/mock-octokit";
import { buildInventory } from "../src/inventory";

function report(name: string, classification: RepoReport["classification"], projectFileCount: number): RepoReport {
  return {
    name,
    defaultBranch: "main",
    pushedAt: "2026-03-01T12:00:00Z",
    classification,
    tfms: classification === "needs-upgrade" ? ["net8.0"] : [],
    projectFileCount,
  };
}

describe("select batching", () => {
  it("slices the upgrade queue to BATCH_SIZE and documents sequential continuation", async () => {
    const octokit = mockOctokit(
      Array.from({ length: 6 }, (_, i) => ({
        name: `repo-${i + 1}`,
        tree: Array.from({ length: i + 1 }, (__, j) => ({
          path: `P${j}.csproj`,
          content: "<TargetFramework>net8.0</TargetFramework>",
        })),
      })),
    );
    const reports = await buildInventory(octokit, { org: "o", activeMonths: 12 });
    const queue = upgradeQueue(reports);
    assert.deepEqual(
      queue.map((r) => r.name),
      ["repo-1", "repo-2", "repo-3", "repo-4", "repo-5", "repo-6"],
      "queue is smallest-project-first",
    );

    const config = loadConfig({ GITHUB_ORG: "LBHackney", GITHUB_TOKEN: "ghs_test", BATCH_SIZE: "4" });
    assert.equal(config.batchSize, 4);

    // Same helper the CLI uses: do not import main.ts (it exits on load).
    const first = queue.slice(0, config.batchSize);
    const rest = queue.slice(config.batchSize);
    assert.deepEqual(
      first.map((r) => r.name),
      ["repo-1", "repo-2", "repo-3", "repo-4"],
    );
    assert.deepEqual(
      rest.map((r) => r.name),
      ["repo-5", "repo-6"],
      "a later run continues from the remaining queue slice",
    );
  });

  it("drops non-upgrade classifications before slicing", () => {
    const queue = upgradeQueue([
      report("keep-small", "needs-upgrade", 1),
      report("skip-fw", "framework", 1),
      report("keep-big", "needs-upgrade", 9),
      report("skip-incomplete", "incomplete", 2),
    ]);
    assert.deepEqual(
      queue.slice(0, 4).map((r) => r.name),
      ["keep-small", "keep-big"],
    );
  });
});
