import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isArtifactPath, isForbiddenPath } from "../src/upgrade";

const hostile = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "hostile");

describe("isArtifactPath", () => {
  it("matches bin, obj, TestResults, and binlog outputs", () => {
    assert.equal(isArtifactPath("bin/App.dll"), true);
    assert.equal(isArtifactPath("src/obj/x.dll"), true);
    assert.equal(isArtifactPath("tests/TestResults/out.trx"), true);
    assert.equal(isArtifactPath("a/b.binlog"), true);
    assert.equal(isArtifactPath("src/App.csproj"), false);
  });
});

describe("isForbiddenPath", () => {
  it("refuses .github, nested .github, .claude, .cursor, .ssh, .env, .envrc, .npmrc, .netrc, .gitattributes, and .gitmodules", () => {
    for (const p of [
      ".github/workflows/ci.yml",
      "sub/.github/x.yml",
      ".claude/settings.json",
      ".cursor/rules.md",
      "nested/.cursor/rules.md",
      ".env",
      ".env.local",
      ".gitattributes",
      "dir/.gitattributes",
      ".gitmodules",
      ".npmrc",
      "dir/.npmrc",
      ".netrc",
      ".envrc",
      ".ssh/id_rsa",
    ]) {
      assert.equal(isForbiddenPath(p), true, `must refuse ${p}`);
    }
  });

  it("allows ordinary sources such as src/global.json and App.csproj", () => {
    assert.equal(isForbiddenPath("src/global.json"), false);
    assert.equal(isForbiddenPath("App.csproj"), false);
    assert.equal(isForbiddenPath("src/App.csproj"), false);
  });

  it("flags the hostile fixture files", () => {
    for (const rel of [".github/workflows/ci.yml", ".cursor/rules.md", ".env", ".gitattributes"]) {
      assert.ok(fs.existsSync(path.join(hostile, rel)), `missing fixture ${rel}`);
      assert.equal(isForbiddenPath(rel), true, `must refuse hostile ${rel}`);
    }
    assert.ok(fs.existsSync(path.join(hostile, ".git", "hooks", "pre-commit")));
  });
});
