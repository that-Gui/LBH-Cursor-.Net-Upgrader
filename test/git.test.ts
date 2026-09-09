import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, REPO_NAME } from "../src/upgrade";

const token = "ghs_git_isolation_token";
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "git-iso-"));

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("REPO_NAME", () => {
  it("rejects path traversal and slashes; accepts My.Repo-1_x", () => {
    assert.equal(REPO_NAME.test("../evil"), false);
    assert.equal(REPO_NAME.test("a/b"), false);
    assert.equal(REPO_NAME.test("My.Repo-1_x"), true);
  });
});

describe("git()", () => {
  it("does not run a planted pre-commit hook", () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, "hook-"));
    git(["init", "-b", "main"], cwd, token);
    fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");
    const hook = path.join(cwd, ".git", "hooks", "pre-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, "#!/bin/sh\nprintf 'ran\\n' > hook-ran\nexit 1\n", { mode: 0o755 });
    git(["add", "README.md"], cwd, token);
    git(["commit", "-m", "init"], cwd, token);
    assert.equal(fs.existsSync(path.join(cwd, "hook-ran")), false);
    assert.equal(fs.existsSync(path.join(cwd, ".git", "hooks", "pre-commit")), true);
    assert.match(git(["log", "-1", "--format=%s"], cwd, token), /init/);
  });

  it("does not persist a credential in local config; authenticate shows basic", () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, "cred-"));
    git(["init", "-b", "main"], cwd, token);
    assert.throws(
      () => git(["config", "--get", "http.https://github.com/.extraheader"], cwd, token),
      /git config failed/,
    );
    const header = git(
      ["config", "--get", "http.https://github.com/.extraheader"],
      cwd,
      token,
      true,
    );
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    assert.match(header, /AUTHORIZATION: basic /i);
    assert.ok(header.includes(basic));
    assert.throws(
      () => git(["config", "--get", "http.https://github.com/.extraheader"], cwd, token),
      /git config failed/,
      "credential must not remain after an unauthenticated call",
    );
    const local = spawnSync("git", ["config", "--local", "--get-regexp", "http\\..*extraheader"], {
      cwd,
      encoding: "utf8",
    });
    assert.ok(local.status !== 0 || !local.stdout.trim(), "credential must not be written to local config");
  });

  it("ignores a global url.*.insteadOf rewrite", () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, "instead-"));
    const home = fs.mkdtempSync(path.join(tmpRoot, "home-"));
    const globalCfg = path.join(home, "gitconfig");
    fs.writeFileSync(
      globalCfg,
      "[url \"ssh://git@github.com/\"]\n\tinsteadOf = https://github.com/\n",
    );
    git(["init", "-b", "main"], cwd, token);
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
    const prevHome = process.env.HOME;
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    process.env.HOME = home;
    try {
      assert.throws(
        () => git(["config", "--get", "url.ssh://git@github.com/.insteadOf"], cwd, token),
        /git config failed/,
      );
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });

  it("ignores GIT_DIR from the parent environment", () => {
    const cwd = fs.mkdtempSync(path.join(tmpRoot, "gitdir-"));
    const other = fs.mkdtempSync(path.join(tmpRoot, "other-"));
    git(["init", "-b", "main"], cwd, token);
    git(["init", "-b", "main"], other, token);
    fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");
    const prev = process.env.GIT_DIR;
    process.env.GIT_DIR = path.join(other, ".git");
    try {
      git(["add", "README.md"], cwd, token);
      git(["commit", "-m", "init"], cwd, token);
    } finally {
      if (prev === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prev;
    }
    assert.match(git(["log", "-1", "--format=%s"], cwd, token), /init/);
    assert.throws(
      () => git(["log", "-1", "--format=%s"], other, token),
      /git log failed/,
      "the commit must land in cwd, not the GIT_DIR target",
    );
  });
});
