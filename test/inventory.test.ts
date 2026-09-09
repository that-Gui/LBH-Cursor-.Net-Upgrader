import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildInventory,
  classify,
  formatInventory,
  inspectRepo,
  MAX_FETCHES_PER_REPO,
  MAX_PARSE_CHARS,
  ownsRepo,
  upgradeQueue,
  type RepoReport,
} from "../src/inventory";
import { mockOctokit } from "./helpers/mock-octokit";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function report(partial: Partial<RepoReport> & Pick<RepoReport, "name" | "classification">): RepoReport {
  return {
    defaultBranch: "main",
    pushedAt: "2026-03-01T12:00:00Z",
    tfms: [],
    projectFileCount: 1,
    ...partial,
  };
}

function csproj(name: string, file = "App.csproj"): string {
  return fs.readFileSync(path.join(fixtures, name, file), "utf8");
}

describe("classify", () => {
  const cases: [string[], string | undefined, RepoReport["classification"]][] = [
    [["net8.0"], undefined, "needs-upgrade"],
    [["net8.0-windows"], undefined, "needs-upgrade"],
    [["netcoreapp3.1"], undefined, "needs-upgrade"],
    [[], "8.0.100", "needs-upgrade"],
    [["net10.0"], undefined, "up-to-date"],
    [["net8.0", "net10.0"], undefined, "up-to-date"],
    [["net472"], undefined, "framework"],
    [["netstandard2.0"], undefined, "netstandard-only"],
    [[], undefined, "no-dotnet"],
  ];

  for (const [tfms, sdk, want] of cases) {
    it(`classify(${JSON.stringify(tfms)}, ${JSON.stringify(sdk)}) → ${want}`, () => {
      assert.equal(classify(tfms, sdk), want);
    });
  }
});

describe("hostile TFM parse", () => {
  it("stays bounded under 5s using MAX_PARSE_CHARS", () => {
    const started = Date.now();
    const hostile = "<TargetFramework ".repeat(MAX_PARSE_CHARS).slice(0, MAX_PARSE_CHARS);
    assert.equal([...hostile.matchAll(/<TargetFrameworks?(?:\s[^>]*)?>([^<]+)<\/TargetFrameworks?>/gi)].length, 0);
    assert.ok(Date.now() - started < 5_000, "TFM parse must stay bounded on hostile input");
  });
});

describe("upgradeQueue", () => {
  it("drops incomplete repos", () => {
    const queued = upgradeQueue([
      report({ name: "a", classification: "needs-upgrade" }),
      report({ name: "b", classification: "incomplete" }),
    ]);
    assert.deepEqual(
      queued.map((r) => r.name),
      ["a"],
      "incomplete repos must not be queued",
    );
  });
});

describe("ownsRepo", () => {
  const codeowners = [
    "# This file specifies owners for pull request approval",
    "# See https://help.github.com/articles/about-code-owners/ @example-org/ghost-team",
    "",
    "* @example-org/shared-services",
    "/docs/ @example-org/backend-team @octocat dev@example.com",
    "@example-org/looks-like-an-owner @example-org/docs-team",
  ].join("\n");

  const owned: [string, string, boolean][] = [
    [codeowners, "@example-org/shared-services", true],
    [codeowners, "example-org/shared-services", true],
    [codeowners, "@example-ORG/SHARED-SERVICES", true],
    [codeowners, "@example-org/ghost-team", false],
    [codeowners, "@example-org/backend", false],
    [codeowners, "@octocat", true],
    [codeowners, "dev@example.com", true],
    [codeowners, "@example-org/looks-like-an-owner", false],
    ["", "@example-org/shared-services", false],
  ];

  for (const [file, owner, want] of owned) {
    it(`ownsRepo(_, ${JSON.stringify(owner)}) → ${want}`, () => {
      assert.equal(ownsRepo(file, owner), want);
    });
  }
});

describe("buildInventory CODE_OWNERS filter", () => {
  const stub = mockOctokit(
    ["ours", "theirs"].map((name) => ({
      name,
      tree: [
        { path: "CODEOWNERS", size: 40 },
        { path: "App.csproj", size: 100 },
      ],
      files: {
        CODEOWNERS: `* @org/${name === "ours" ? "mine" : "yours"}`,
        "App.csproj": "<TargetFramework>net8.0</TargetFramework>",
      },
    })),
  );
  const opts = { org: "o", activeMonths: 12 };

  it("scans the whole org when unfiltered", async () => {
    const unfiltered = await buildInventory(stub, opts);
    assert.deepEqual(
      unfiltered.map((r) => r.name),
      ["ours", "theirs"],
      "CODE_OWNERS=0 scans the whole org",
    );
  });

  it("drops another team's repos when CODE_OWNERS is set", async () => {
    const filtered = await buildInventory(stub, { ...opts, codeOwner: "@org/mine" });
    assert.deepEqual(
      filtered.map((r) => r.name),
      ["ours"],
      "CODE_OWNERS drops another team's repos",
    );
    assert.equal(filtered[0]?.classification, "needs-upgrade", "a kept repo is still classified");
  });

  it("yields an empty inventory when nobody matches", async () => {
    const none = await buildInventory(stub, { ...opts, codeOwner: "@org/nobody" });
    assert.deepEqual(none, [], "an owner nobody matches yields an empty inventory");
  });
});

describe("unsafe repo names", () => {
  it("drops a GitHub name that is not a safe clone directory name", async () => {
    const octokit = mockOctokit([
      { name: "../evil", tree: [{ path: "App.csproj", content: "<TargetFramework>net8.0</TargetFramework>" }] },
      { name: "ok-repo", tree: [{ path: "App.csproj", content: "<TargetFramework>net8.0</TargetFramework>" }] },
    ]);
    const reports = await buildInventory(octokit, { org: "o", activeMonths: 12 });
    assert.deepEqual(
      reports.map((r) => r.name),
      ["ok-repo"],
    );
  });
});

describe("incomplete evidence", () => {
  it("classifies a truncated tree as incomplete, not queued", async () => {
    const octokit = mockOctokit([
      {
        name: "padded",
        truncated: true,
        tree: [{ path: "App.csproj", content: csproj("net8") }],
      },
    ]);
    const reports = await buildInventory(octokit, { org: "o", activeMonths: 12 });
    assert.equal(reports[0]?.classification, "incomplete");
    assert.deepEqual(upgradeQueue(reports), []);
  });

  it("classifies too many project files as incomplete, not queued", async () => {
    const tree = Array.from({ length: MAX_FETCHES_PER_REPO + 1 }, (_, i) => ({
      path: `P${i}.csproj`,
      size: 80,
      content: "<TargetFramework>net8.0</TargetFramework>",
    }));
    const octokit = mockOctokit([{ name: "huge", tree }]);
    const reports = await buildInventory(octokit, { org: "o", activeMonths: 12 });
    assert.equal(reports[0]?.classification, "incomplete");
    assert.deepEqual(upgradeQueue(reports), []);
  });
});

describe("fixture trees", () => {
  it("classifies net8, net10, mixed framework, and netstandard fixtures", async () => {
    const octokit = mockOctokit([
      { name: "net8", tree: [{ path: "App.csproj", content: csproj("net8") }] },
      {
        name: "net10",
        tree: [
          { path: "App.csproj", content: csproj("net10") },
          { path: "global.json", content: fs.readFileSync(path.join(fixtures, "net10", "global.json"), "utf8") },
        ],
      },
      {
        name: "framework",
        tree: [
          { path: "App.csproj", content: csproj("framework") },
          { path: "Library.csproj", content: csproj("framework", "Library.csproj") },
        ],
      },
      { name: "netstandard", tree: [{ path: "Lib.csproj", content: csproj("netstandard", "Lib.csproj") }] },
    ]);
    const reports = await buildInventory(octokit, { org: "o", activeMonths: 12 });
    const byName = Object.fromEntries(reports.map((r) => [r.name, r.classification]));
    assert.equal(byName.net8, "needs-upgrade");
    assert.equal(byName.net10, "up-to-date");
    assert.equal(byName.framework, "framework");
    assert.equal(byName.netstandard, "netstandard-only");
  });
});

describe("formatInventory", () => {
  it("mentions the upgrade queue and excluded buckets", () => {
    const text = formatInventory([
      report({ name: "upgrade-me", classification: "needs-upgrade", tfms: ["net8.0"], projectFileCount: 2 }),
      report({ name: "old-fx", classification: "framework", tfms: ["net472"] }),
      report({ name: "std", classification: "netstandard-only", tfms: ["netstandard2.0"] }),
      report({ name: "partial", classification: "incomplete", tfms: ["net8.0"] }),
    ]);
    assert.match(text, /^Upgrade queue \(1\):/m);
    assert.match(text, /upgrade-me/);
    assert.match(text, /Excluded — \.NET Framework: old-fx/);
    assert.match(text, /Excluded — netstandard-only: std/);
    assert.match(text, /Excluded — incomplete scan: partial/);
    assert.ok(!text.split("\n")[1]?.includes("partial"));
  });
});

describe("inspectRepo", () => {
  it("returns incomplete for a truncated needs-upgrade repo", async () => {
    const octokit = mockOctokit([
      {
        name: "trunc",
        truncated: true,
        tree: [{ path: "App.csproj", content: "<TargetFramework>net8.0</TargetFramework>" }],
      },
    ]);
    const report = await inspectRepo(octokit, "o", "trunc", "main", "2026-03-01T00:00:00Z");
    assert.equal(report?.classification, "incomplete");
  });
});
