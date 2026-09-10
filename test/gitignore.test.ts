import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe(".gitignore", () => {
  it("ignores all of work/ so nested clones cannot become gitlinks", () => {
    const rules = fs
      .readFileSync(path.join(root, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());
    assert.ok(rules.includes("work/"), "expected a bare `work/` rule in .gitignore");

    for (const rel of ["work/repos/addresses-api", "work/runs/run-1/result.json", "work/logs/x.log"]) {
      const res = spawnSync("git", ["check-ignore", "-q", "--no-index", rel], { cwd: root });
      assert.equal(res.status, 0, `${rel} is not gitignored`);
    }
  });
});
