import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertResultIdentity,
  markLoopComplete,
  readManifest,
  readPristineGitConfig,
  readResult,
  runDir,
  transitionPhase,
  writeAudit,
  writeLog,
  writeManifest,
  writePristineGitConfig,
  writeResult,
} from "../src/upgrade";
import { sampleManifest, sampleResult } from "./helpers/sample-result";

function modeOf(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "run-state-"));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("write/read roundtrip", () => {
  it("persists manifest, result, audit, git-config, and log under 0700/0600", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "work-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    fs.mkdirSync(cloneDir, { recursive: true });
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const manifest = sampleManifest(workDir, cloneDir, { runId });
    const result = sampleResult();

    writeManifest(dir, manifest);
    writeResult(dir, result);
    writeAudit(dir, "audit line\n");
    writePristineGitConfig(dir, Buffer.from("[core]\n\trepositoryformatversion = 0\n"));
    const logFile = writeLog(workDir, manifest.repo, "helper log\n");

    assert.deepEqual(readManifest(dir), manifest);
    assert.deepEqual(readResult(dir), result);
    assert.equal(readPristineGitConfig(dir).toString(), "[core]\n\trepositoryformatversion = 0\n");
    assert.equal(fs.readFileSync(logFile, "utf8"), "helper log\n");

    assert.equal(modeOf(dir), 0o700);
    assert.equal(modeOf(path.join(dir, "manifest.json")), 0o600);
    assert.equal(modeOf(path.join(dir, "result.json")), 0o600);
    assert.equal(modeOf(path.join(dir, "audit.md")), 0o600);
    assert.equal(modeOf(path.join(dir, "git-config")), 0o600);
    assert.equal(modeOf(logFile), 0o600);
  });
});

describe("runDir", () => {
  it("rejects a runId that contains a slash or is empty", () => {
    const workDir = path.join(tmpRoot, "slash");
    assert.throws(() => runDir(workDir, "a/b"), /invalid runId/);
    assert.throws(() => runDir(workDir, "a\\b"), /invalid runId/);
    assert.throws(() => runDir(workDir, ""), /invalid runId/);
    assert.throws(() => runDir(workDir, ".."), /invalid runId/);
    assert.throws(() => runDir(workDir, "a b"), /invalid runId/);
    assert.throws(() => runDir(workDir, "run\nid"), /invalid runId/);
  });
});

describe("transitionPhase", () => {
  function seeded(phase: "prepared" | "loop-complete" | "finalized" | "failed") {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "phase-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const manifest = sampleManifest(workDir, cloneDir, { runId, phase });
    writeManifest(dir, manifest);
    return manifest;
  }

  it("allows prepared → loop-complete|failed and loop-complete → finalized|failed", () => {
    assert.equal(transitionPhase(seeded("prepared"), "loop-complete").phase, "loop-complete");
    assert.equal(transitionPhase(seeded("prepared"), "failed").phase, "failed");
    assert.equal(transitionPhase(seeded("loop-complete"), "finalized").phase, "finalized");
    assert.equal(transitionPhase(seeded("loop-complete"), "failed").phase, "failed");
    assert.equal(transitionPhase(seeded("failed"), "failed").phase, "failed");
    assert.equal(transitionPhase(seeded("finalized"), "finalized").phase, "finalized");
  });

  it("throws on illegal transitions", () => {
    assert.throws(() => transitionPhase(seeded("prepared"), "finalized"), /illegal phase transition/);
    assert.throws(() => transitionPhase(seeded("loop-complete"), "prepared"), /illegal phase transition/);
    assert.throws(() => transitionPhase(seeded("failed"), "prepared"), /illegal phase transition/);
    assert.throws(() => transitionPhase(seeded("failed"), "loop-complete"), /illegal phase transition/);
    assert.throws(() => transitionPhase(seeded("finalized"), "failed"), /illegal phase transition/);
  });
});

describe("assertResultIdentity", () => {
  it("throws when repo, branch, or baseSha do not match the manifest", () => {
    const workDir = "/tmp/work-id";
    const cloneDir = "/tmp/work-id/repos/My.Repo-1_x";
    const manifest = sampleManifest(workDir, cloneDir);
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ repo: "nope" })),
      /result identity does not match/,
    );
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ branch: "other" })),
      /result identity does not match/,
    );
    assert.throws(
      () => assertResultIdentity(manifest, sampleResult({ baseSha: "0000" })),
      /result identity does not match/,
    );
    assert.doesNotThrow(() => assertResultIdentity(manifest, sampleResult()));
  });
});

describe("markLoopComplete", () => {
  function preparedRun(result = sampleResult()) {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "complete-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(dir, sampleManifest(workDir, cloneDir, { runId, phase: "prepared" }));
    writeResult(dir, result);
    return { workDir, runId, dir };
  }

  it("advances prepared → loop-complete when result.json is finalizable", () => {
    const { workDir, runId, dir } = preparedRun();
    const updated = markLoopComplete(workDir, runId);
    assert.equal(updated.phase, "loop-complete");
    assert.equal(readManifest(dir).phase, "loop-complete");
  });

  it("is idempotent when already loop-complete", () => {
    const { workDir, runId } = preparedRun();
    markLoopComplete(workDir, runId);
    assert.equal(markLoopComplete(workDir, runId).phase, "loop-complete");
  });

  it("throws when the result is not finalizable", () => {
    const { workDir, runId } = preparedRun(sampleResult({ reviewers: "FAIL" }));
    assert.throws(() => markLoopComplete(workDir, runId), /not finalizable/);
  });

  it("throws on identity mismatch", () => {
    const { workDir, runId } = preparedRun(sampleResult({ repo: "other" }));
    assert.throws(() => markLoopComplete(workDir, runId), /result identity does not match/);
  });
});

describe("manifest bounds", () => {
  it("rejects a cloneDir outside workDir/repos/<repo>", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "bounds-"));
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    const outside = fs.mkdtempSync(path.join(tmpRoot, "outside-"));
    writeManifest(dir, sampleManifest(workDir, outside, { runId }));
    assert.throws(() => readManifest(dir), /cloneDir must be/);
  });

  it("rejects a cloneUrl that looks like a git option or ext protocol", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "url-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, { runId, cloneUrl: "--upload-pack=evil" }),
    );
    assert.throws(() => readManifest(dir), /cloneUrl/);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, { runId, cloneUrl: "ext::sh -c evil" }),
    );
    assert.throws(() => readManifest(dir), /cloneUrl/);
  });

  it("rejects an upgradeBranch that could be parsed as a git flag", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "branch-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    writeManifest(
      dir,
      sampleManifest(workDir, cloneDir, {
        runId,
        upgradeBranch: "--output=/tmp/pwned",
      }),
    );
    assert.throws(() => readManifest(dir), /upgradeBranch is invalid/);
  });

  it("rejects a cloneDir that is a symlink out of workDir", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "symlink-"));
    const cloneDir = path.join(workDir, "repos", "My.Repo-1_x");
    const runId = "My.Repo-1_x-20260101-120";
    const dir = runDir(workDir, runId);
    fs.mkdirSync(path.dirname(cloneDir), { recursive: true });
    const outside = fs.mkdtempSync(path.join(tmpRoot, "link-target-"));
    fs.symlinkSync(outside, cloneDir);
    writeManifest(dir, sampleManifest(workDir, cloneDir, { runId }));
    assert.throws(() => readManifest(dir), /outside the expected repo directory/);
  });
});

describe("writeLog", () => {
  it("uses 0600 and cannot follow a pre-planted symlink (rm + wx)", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "log-"));
    const victim = path.join(workDir, "victim.txt");
    fs.writeFileSync(victim, "untouched\n", { mode: 0o600 });
    const logsDir = path.join(workDir, "logs");
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    const logFile = path.join(logsDir, "My.Repo-1_x.log");
    fs.symlinkSync(victim, logFile);

    const written = writeLog(workDir, "My.Repo-1_x", "safe log\n");
    assert.equal(written, logFile);
    assert.equal(fs.lstatSync(logFile).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(logFile, "utf8"), "safe log\n");
    assert.equal(fs.readFileSync(victim, "utf8"), "untouched\n");
    assert.equal(modeOf(logFile), 0o600);
  });

  it("rejects a repo name that is not REPO_NAME-safe", () => {
    const workDir = fs.mkdtempSync(path.join(tmpRoot, "badlog-"));
    assert.throws(() => writeLog(workDir, "../evil", "x"), /unexpected repo name/);
    assert.throws(() => writeLog(workDir, "a/b", "x"), /unexpected repo name/);
  });
});
