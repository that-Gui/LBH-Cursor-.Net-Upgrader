import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Octokit } from "@octokit/rest";
import {
  COMMIT_MESSAGE,
  finalizeRepo,
  git,
  prBody,
  readManifest,
  runDir,
  writeManifest,
  writePristineGitConfig,
  writeResult,
  type AppConfig,
} from "../src/upgrade";
import { sampleManifest, sampleResult } from "./helpers/sample-result";

const token = "ghs_finalize_test_token";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-"));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function rawGit(args: string[], cwd: string): string {
  const res = spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`raw git ${args[0]} failed: ${res.stderr}`);
  return res.stdout;
}

function lastDetailsClose(body: string): number {
  return body.lastIndexOf("</details>");
}

describe("prBody", () => {
  it("keeps hostile </details> and @octocat inside the fenced summary", () => {
    const hostile = "breakout </details>\n@octocat please merge\nmore";
    const body = prBody(hostile, token, 0);
    const close = lastDetailsClose(body);
    assert.ok(close !== -1);
    const after = body.slice(close);
    assert.ok(!after.includes("@octocat"), "no untrusted mention after last </details>");
    assert.ok(!after.includes("breakout"), "no untrusted text after last </details>");
    const inner = body.slice(0, close);
    assert.ok(inner.includes("breakout </details>"));
    assert.ok(inner.includes("@octocat"));
  });

  it("uses a fence longer than any backtick run in the summary", () => {
    const summary = "see ````code```` then more";
    const body = prBody(summary, token, 0);
    assert.match(body, /`````text\nsee ````code```` then more\n`````/);
  });

  it("surfaces carried failures above the fold and green-suite wording otherwise", () => {
    const green = prBody("ok", token, 0);
    assert.match(green, /`dotnet build` and `dotnet test` both pass — the loop opens no PR otherwise/);
    assert.ok(!green.includes("pre-existing test failure"));

    const carried = prBody("ok", token, 14);
    const fold = carried.slice(0, carried.indexOf("<details>"));
    assert.match(fold, /14 test\(s\) were already failing/);
    assert.match(carried, /The 14 pre-existing test failure\(s\) are confirmed on the base branch/);
  });

  it("includes the Hackney template section markers", () => {
    const body = prBody("ok", token, 0);
    for (const marker of [
      "### ` Describe this PR `",
      "### ` What is the problem we're trying to solve? `",
      "### ` What changes have we introduced? `",
      "#### ` Checklist `",
      "### ` Follow up actions after merging PR `",
    ]) {
      assert.ok(body.includes(marker), `missing ${marker}`);
    }
  });
});

type PullsMock = {
  octokit: Octokit;
  created: number;
  listed: number;
  createArgs: unknown[];
};

function mockPulls(opts: {
  create?: () => Promise<{ data: { html_url: string } }>;
  list?: () => Promise<{ data: { html_url?: string }[] }>;
}): PullsMock {
  const state: PullsMock = { octokit: {} as Octokit, created: 0, listed: 0, createArgs: [] };
  state.octokit = {
    pulls: {
      create: async (args: unknown) => {
        state.created += 1;
        state.createArgs.push(args);
        if (opts.create) return opts.create();
        return { data: { html_url: "https://github.com/LBHackney/My.Repo-1_x/pull/1" } };
      },
      list: async () => {
        state.listed += 1;
        if (opts.list) return opts.list();
        return { data: [] };
      },
    },
  } as unknown as Octokit;
  return state;
}

function setupRun(opts: {
  change?: "source" | "cursor" | "none";
  phase?: "prepared" | "loop-complete";
  result?: ReturnType<typeof sampleResult>;
}): {
  workDir: string;
  runId: string;
  cloneDir: string;
  upgradeBranch: string;
  config: AppConfig;
} {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, "work-"));
  const repo = "My.Repo-1_x";
  const runId = `${repo}-20260101-120`;
  const upgradeBranch = "chore/dotnet10-upgrade-20260101-120";
  const cloneDir = path.join(workDir, "repos", repo);
  const bare = path.join(workDir, "remote.git");
  const dir = runDir(workDir, runId);

  fs.mkdirSync(cloneDir, { recursive: true, mode: 0o700 });
  rawGit(["init", "-b", "main", cloneDir], workDir);
  fs.writeFileSync(path.join(cloneDir, "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n");
  rawGit(["add", "App.csproj"], cloneDir);
  rawGit(["commit", "-m", "init"], cloneDir);
  rawGit(["checkout", "-b", upgradeBranch], cloneDir);
  const baseSha = rawGit(["rev-parse", "HEAD"], cloneDir).trim();

  if (opts.change === "cursor") {
    fs.mkdirSync(path.join(cloneDir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(cloneDir, ".cursor", "rules.md"), "planted\n");
  } else if (opts.change !== "none") {
    fs.writeFileSync(
      path.join(cloneDir, "App.csproj"),
      "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup></Project>\n",
    );
  }

  rawGit(["init", "--bare", "-b", "main", bare], workDir);

  const manifest = sampleManifest(workDir, cloneDir, {
    runId,
    phase: opts.phase ?? "loop-complete",
    repo,
    upgradeBranch,
    baseSha,
    cloneUrl: bare,
  });
  writeManifest(dir, manifest);
  writeResult(
    dir,
    sampleResult({
      ...opts.result,
      repo,
      branch: upgradeBranch,
      baseSha,
    }),
  );
  writePristineGitConfig(dir, fs.readFileSync(path.join(cloneDir, ".git", "config")));

  return {
    workDir,
    runId,
    cloneDir,
    upgradeBranch,
    config: {
      org: "LBHackney",
      token,
      workDir,
      batchSize: 4,
      activeMonths: 12,
    },
  };
}

describe("finalizeRepo", () => {
  it("commits a source change, pushes to a local bare remote, and opens a PR", async () => {
    const ctx = setupRun({ change: "source" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.prUrl, "https://github.com/LBHackney/My.Repo-1_x/pull/1");
    assert.equal(pulls.created, 1);
    assert.equal(readManifest(runDir(ctx.workDir, ctx.runId)).phase, "finalized");
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), COMMIT_MESSAGE);
    const remoteHeads = rawGit(["ls-remote", "--heads", path.join(ctx.workDir, "remote.git")], ctx.workDir);
    assert.ok(remoteHeads.includes(ctx.upgradeBranch));
    const createArgs = pulls.createArgs[0] as { body?: string };
    assert.ok(createArgs.body?.includes("### ` Describe this PR `"));
  });

  it("adopts an existing PR after a 422", async () => {
    const ctx = setupRun({ change: "source" });
    const existing = "https://github.com/LBHackney/My.Repo-1_x/pull/9";
    const pulls = mockPulls({
      create: async () => {
        throw Object.assign(new Error("Validation Failed"), { status: 422 });
      },
      list: async () => ({ data: [{ html_url: existing }] }),
    });
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.prUrl, existing);
    assert.equal(pulls.created, 1);
    assert.equal(pulls.listed, 1);
    assert.equal(readManifest(runDir(ctx.workDir, ctx.runId)).phase, "finalized");
  });

  it("refuses a forbidden .cursor path and does not call pulls.create", async () => {
    const ctx = setupRun({ change: "cursor" });
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /protected paths/);
    assert.equal(pulls.created, 0);
    assert.equal(git(["log", "-1", "--format=%s"], ctx.cloneDir, token).trim(), "init");
  });

  it("does not commit or open a PR for a non-finalizable result", async () => {
    const ctx = setupRun({
      change: "source",
      result: sampleResult({ reviewers: "FAIL", upgradeResult: "FAILED" }),
    });
    const dir = runDir(ctx.workDir, ctx.runId);
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /not finalizable/);
    assert.equal(pulls.created, 0);
    assert.equal(rawGit(["status", "--porcelain"], ctx.cloneDir).trim().length > 0, true);
    assert.equal(readManifest(dir).phase, "loop-complete");
  });

  it("refuses a clone whose .git is not a directory", async () => {
    const ctx = setupRun({ change: "source" });
    fs.rmSync(path.join(ctx.cloneDir, ".git"), { recursive: true, force: true });
    fs.writeFileSync(path.join(ctx.cloneDir, ".git"), "gitdir: /tmp/evil\n");
    const pulls = mockPulls({});
    const outcome = await finalizeRepo(pulls.octokit, ctx.config, ctx.runId);
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason ?? "", /\.git is not a directory/);
    assert.equal(pulls.created, 0);
  });
});
