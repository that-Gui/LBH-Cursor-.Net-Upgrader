import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { childEnv, redact } from "../src/upgrade";

const secret = "ghp_selfcheck_secret";

describe("childEnv", () => {
  it("withholds GITHUB_TOKEN and any env value containing the token", () => {
    const env = childEnv(secret, {
      GITHUB_TOKEN: secret,
      GH_TOKEN: secret,
      OTHER: `prefix-${secret}-suffix`,
      UNRELATED: "keep-me",
    });
    assert.ok(!("GITHUB_TOKEN" in env), "childEnv must withhold GITHUB_TOKEN");
    assert.ok(!("GH_TOKEN" in env), "childEnv must withhold aliases holding the same secret");
    assert.ok(!("OTHER" in env), "childEnv must withhold the token under ANY variable name");
    assert.equal(env.UNRELATED, "keep-me", "childEnv must not drop unrelated vars");
    assert.ok(!Object.values(env).some((v) => v?.includes(secret)));
    assert.equal(env.MSBUILDDISABLENODEREUSE, "1");
    assert.equal(env.DOTNET_CLI_USE_MSBUILD_SERVER, "0");
  });

  it("does not blank the environment when the token is empty", () => {
    const env = childEnv("", { UNRELATED: "keep-me", GITHUB_TOKEN: "x", GH_TOKEN: "other-pat", PATH: "/usr/bin" });
    assert.ok("UNRELATED" in env, "an empty token must not blank the environment");
    assert.equal(env.UNRELATED, "keep-me");
    assert.ok(!("GITHUB_TOKEN" in env), "GITHUB_TOKEN is still withheld by name");
    assert.ok(!("GH_TOKEN" in env), "childEnv must withhold GH_TOKEN by name even when the value differs");
  });
});

describe("redact", () => {
  it("redacts basic auth and the base64 token", () => {
    const basic = Buffer.from(`x-access-token:${secret}`).toString("base64");
    assert.ok(!redact(`fatal: AUTHORIZATION: basic ${basic}`, secret).includes(basic), "redact the basic form");
    assert.ok(!redact(Buffer.from(secret).toString("base64"), secret).includes("c2Vj"), "redact the base64 token");
    assert.equal(redact("abc", ""), "abc", "empty token must not shred the text");
  });

  it("strips control characters but keeps newline and tab", () => {
    assert.equal(redact("a\u001b[2Kb\r\nc", secret), "a[2Kb\nc");
    assert.equal(redact("a\tb\nc", secret), "a\tb\nc");
  });
});
