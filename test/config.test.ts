import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig, numEnv, requireEnv, resolveWorkDir } from "../src/upgrade";

const required = { GITHUB_ORG: "LBHackney", GITHUB_TOKEN: "ghs_test" };

describe("requireEnv", () => {
  it("throws when the variable is missing or blank", () => {
    assert.throws(() => requireEnv("GITHUB_TOKEN", {}), /missing required env var GITHUB_TOKEN/);
    assert.throws(() => requireEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "" }), /missing required env var GITHUB_TOKEN/);
    assert.throws(() => requireEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "   " }), /missing required env var GITHUB_TOKEN/);
  });
});

describe("numEnv", () => {
  it("returns the fallback when unset or blank", () => {
    assert.equal(numEnv("BATCH_SIZE", 4, {}), 4);
    assert.equal(numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "" }), 4);
    assert.equal(numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "  " }), 4);
  });

  it("rejects 0", () => {
    assert.throws(() => numEnv("N", 4, { N: "0" }), /invalid N: 0 \(expected an integer >= 1\)/);
  });

  it("rejects a float", () => {
    assert.throws(() => numEnv("N", 4, { N: "1.5" }), /invalid N: 1.5 \(expected an integer >= 1\)/);
  });

  it("rejects BATCH_SIZE=0", () => {
    assert.throws(
      () => numEnv("BATCH_SIZE", 4, { BATCH_SIZE: "0" }),
      /invalid BATCH_SIZE: 0 \(expected an integer >= 1\)/,
    );
    assert.throws(() => loadConfig({ ...required, BATCH_SIZE: "0" }), /invalid BATCH_SIZE: 0/);
  });
});

describe("loadConfig", () => {
  it("rejects an org outside GitHub's login charset", () => {
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org/name" }), /invalid GITHUB_ORG/);
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org.name" }), /invalid GITHUB_ORG/);
    assert.throws(() => loadConfig({ ...required, GITHUB_ORG: "org_name" }), /invalid GITHUB_ORG/);
    assert.equal(loadConfig({ ...required, GITHUB_ORG: "My-Org" }).org, "My-Org");
  });

  it("treats CODE_OWNERS=0 and unset as no filter, and keeps @org/team", () => {
    assert.equal(loadConfig(required).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: "0" }).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: " 0 " }).codeOwner, undefined);
    assert.equal(loadConfig({ ...required, CODE_OWNERS: "@org/team" }).codeOwner, "@org/team");
  });

  it("rejects BATCH_SIZE above the cap and a token with internal whitespace", () => {
    assert.throws(() => loadConfig({ ...required, BATCH_SIZE: "33" }), /invalid BATCH_SIZE: 33/);
    assert.throws(
      () => loadConfig({ ...required, GITHUB_TOKEN: "ghs_test token" }),
      /GITHUB_TOKEN: whitespace is not allowed/,
    );
    assert.throws(
      () => loadConfig({ ...required, CODE_OWNERS: "team\nowner" }),
      /CODE_OWNERS: control characters/,
    );
  });
});

describe("resolveWorkDir", () => {
  const cwd = "/tmp/upgrader";
  const home = "/Users/tester";

  it("refuses cwd, homedir, and the filesystem root", () => {
    assert.throws(() => resolveWorkDir(".", cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir(cwd, cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir(home, cwd, home), /refusing .* as WORK_DIR/);
    assert.throws(() => resolveWorkDir("/", cwd, home), /refusing .* as WORK_DIR/);
  });

  it("accepts a nested directory of its own", () => {
    assert.equal(resolveWorkDir("work", cwd, home), path.resolve(cwd, "work"));
    assert.equal(resolveWorkDir("./nested/work", cwd, home), path.resolve(cwd, "nested/work"));
  });
});
