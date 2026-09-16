import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cursor = path.join(root, ".cursor");

function read(rel: string): string {
  return fs.readFileSync(path.join(cursor, rel), "utf8");
}

function frontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m?.[1], "missing YAML frontmatter");
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const skills = {
  upgrader: "skills/dotnet10-upgrader/SKILL.md",
  loop: "skills/engineering-implementation-loop/SKILL.md",
} as const;

const agents = {
  writer: "agents/lbh-dotnet10-implementation-agent.md",
  adversarial: "agents/lbh-dotnet10-adversarial-reviewer.md",
  architectural: "agents/lbh-dotnet10-architectural-reviewer.md",
} as const;

describe("Cursor asset names", () => {
  it("matches folder and file conventions to frontmatter name", () => {
    const up = frontmatter(read(skills.upgrader));
    assert.equal(up.name, "dotnet10-upgrader");
    assert.equal(path.basename(path.dirname(path.join(cursor, skills.upgrader))), up.name);

    const loop = frontmatter(read(skills.loop));
    assert.equal(loop.name, "engineering-implementation-loop");
    assert.equal(path.basename(path.dirname(path.join(cursor, skills.loop))), loop.name);

    for (const rel of Object.values(agents)) {
      const fm = frontmatter(read(rel));
      assert.equal(path.basename(rel, ".md"), fm.name);
    }
  });
});

describe("skill frontmatter", () => {
  it("sets disable-model-invocation: true on both skills", () => {
    assert.equal(frontmatter(read(skills.upgrader))["disable-model-invocation"], "true");
    assert.equal(frontmatter(read(skills.loop))["disable-model-invocation"], "true");
  });
});

describe("agent frontmatter", () => {
  it("pins each requested model; reviewers readonly, writer writable", () => {
    const writer = frontmatter(read(agents.writer));
    const adv = frontmatter(read(agents.adversarial));
    const arch = frontmatter(read(agents.architectural));
    assert.equal(writer.model, "cursor-grok-4.6-high");
    assert.equal(adv.model, "claude-opus-5-thinking-high");
    assert.equal(arch.model, "gpt-5.6-sol-xhigh");
    assert.equal(writer.readonly, "false");
    assert.equal(adv.readonly, "true");
    assert.equal(arch.readonly, "true");
  });
});

describe("loop skill contract", () => {
  it("mentions fresh writer, never resume, parallel reviewers, four rounds, three-round stop, TARGET_REPO_PATH, RUN_ID", () => {
    const text = read(skills.loop);
    assert.match(text, /fresh/i);
    assert.match(text, /never resume/i);
    assert.match(text, /parallel/i);
    assert.match(text, /[Ff]our rounds/);
    assert.match(text, /three rounds/);
    assert.match(text, /TARGET_REPO_PATH/);
    assert.match(text, /RUN_ID/);
  });
});

const playbookStart = "Upgrade this repository to .NET 10 (LTS).";

/** The request text itself, without the wrapper prose each copy adds around it. */
function playbookBody(text: string): string {
  const start = text.indexOf(playbookStart);
  assert.ok(start >= 0, "missing the playbook request text");
  const marker = text.indexOf("UPGRADE_RESULT:", start);
  assert.ok(marker >= 0, "missing the UPGRADE_RESULT marker line");
  const eol = text.indexOf("\n", marker);
  return text.slice(start, eol === -1 ? text.length : eol);
}

describe("playbook contract", () => {
  it("keeps the reference copy and the inline copy identical", () => {
    assert.equal(
      playbookBody(read("skills/dotnet10-upgrader/references/playbook.md")),
      playbookBody(read(skills.upgrader)),
    );
  });

  it("keeps the upgrade scope rules the loop is judged against", () => {
    const playbook = playbookBody(read("skills/dotnet10-upgrader/references/playbook.md"));
    assert.match(playbook, /only where the retarget forces the move/);
    assert.match(playbook, /vulnerability advisory[\s\S]*is not a reason to move it/);
    assert.match(playbook, /Do not add a package reference the repository did not already have/);
    assert.match(playbook, /Do not suppress warnings or audit findings/);
  });

  it("repeats those rules to the writer and makes them criticals for the adversarial reviewer", () => {
    const writer = read(agents.writer);
    assert.match(writer, /only where the retarget forces it/i);
    assert.match(writer, /Do not add a package reference the repository did not already have/);
    assert.match(writer, /Do not suppress warnings or audit findings/);
    assert.match(writer, /evidence` is mandatory/);

    const adversarial = read(agents.adversarial);
    assert.match(adversarial, /the retarget did not force/);
    assert.match(adversarial, /no restore\/build error in the logs/);
    assert.match(adversarial, /new warning or audit suppression/i);

    assert.match(read(agents.architectural), /new warning or audit suppression/i);
  });
});

describe("upgrader skill contract", () => {
  it("mentions inventory|run, prepare-repo, complete-run, finalize, result.json, and sequential batching", () => {
    const text = read(skills.upgrader);
    assert.match(text, /inventory\|run|\/dotnet10-upgrader inventory[\s\S]*\/dotnet10-upgrader run/);
    assert.match(text, /prepare-repo/);
    assert.match(text, /complete-run/);
    assert.match(text, /finalize/);
    assert.match(text, /result\.json/);
    assert.match(text, /schemaVersion|baselineFailures|reviewers|upgradeResult|unresolvedCriticals/);
    assert.match(text, /sequentially|sequential/i);
  });
});
