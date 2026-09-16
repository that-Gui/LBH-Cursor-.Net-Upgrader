import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hookDir = path.join(root, ".cursor", "hooks");
const hookScript = path.join(hookDir, "block-git-writes.mjs");
const hookWrapper = path.join(hookDir, "block-git-writes.sh");

/** Run the hook the way Cursor does — payload on stdin, decision on stdout. */
function run(stdin: string, argv: string[] = [process.execPath, hookScript]): { permission: string; message: string } {
  const [command, ...args] = argv as [string, ...string[]];
  const result = spawnSync(command, args, { input: stdin, encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  assert.notEqual(result.stdout.trim(), "", "hook wrote no decision, which failClosed turns into a deny of every git command");
  const decision = JSON.parse(result.stdout) as { continue: boolean; permission: string; user_message?: string };
  assert.equal(decision.continue, true);
  return { permission: decision.permission, message: decision.user_message ?? "" };
}

function decide(command: string): string {
  return run(JSON.stringify({ command, cwd: root, sandbox: false })).permission;
}

function readHookEntry(): { command: string; matcher?: string; failClosed?: boolean; timeout?: number } {
  const config = JSON.parse(fs.readFileSync(path.join(root, ".cursor", "hooks.json"), "utf8")) as {
    version: number;
    hooks: { beforeShellExecution: { command: string; matcher?: string; failClosed?: boolean; timeout?: number }[] };
  };
  assert.equal(config.version, 1);
  assert.equal(config.hooks.beforeShellExecution.length, 1);
  const entry = config.hooks.beforeShellExecution[0];
  assert.ok(entry, "missing beforeShellExecution entry");
  return entry;
}

/**
 * Command lines the skills and agent prompts tell an agent to run. Extracted
 * rather than hardcoded so a prompt edit that introduces a mutating git
 * command fails here. Only real command lines count: a trimmed line has to
 * start with the git invocation itself, which skips the prose mentions such as
 * "never run `git commit`" that the prompts contain deliberately — but a bare
 * `git commit` added as a command line is caught.
 */
function promptGitCommands(): string[] {
  const sources = [
    ".cursor/skills/engineering-implementation-loop/SKILL.md",
    ".cursor/skills/dotnet10-upgrader/SKILL.md",
    ...fs
      .readdirSync(path.join(root, ".cursor", "agents"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => path.join(".cursor", "agents", name)),
  ];
  const commands = new Set<string>();
  for (const source of sources) {
    const file = path.join(root, source);
    assert.ok(fs.existsSync(file), `missing prompt file ${source}`);
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (/^git\s/.test(trimmed)) commands.add(trimmed);
    }
  }
  return [...commands];
}

/** The automation's own argv vectors, as they would look if routed through a shell. */
const automationArgv = [
  ["commit", "--no-verify", "-m", "chore: target net10.0"],
  ["push", "--no-verify", "--", "https://github.com/LBH/repo.git", "upgrade/net10:upgrade/net10"],
  ["add", "-A"],
  ["clone", "--depth", "1", "--", "https://github.com/LBH/repo.git", "/tmp/work/repos/repo"],
  ["checkout", "-b", "upgrade/net10"],
];

function shellJoin(args: string[]): string {
  return `git ${args.map((arg) => (/[^A-Za-z0-9_./:@-]/.test(arg) ? `'${arg}'` : arg)).join(" ")}`;
}

/**
 * Every command the hook must refuse, grouped by the way it hides the
 * mutation. The matcher test replays the whole set, so a narrower matcher —
 * the class of bug that makes the hook silently stop firing — fails here.
 */
const denied = {
  subcommands: [
    "git commit -m x",
    "git push",
    "git push --force",
    "git reset --hard HEAD",
    "git checkout main",
    "git switch main",
    "git stash",
    "git add -A",
    "git clean -fd",
    "git rebase main",
    "git config user.email me@example.com",
    "git branch -D feature",
    "git remote set-url origin x",
  ],
  chained: ["git diff HEAD && git commit -m x", "git status; git push", "echo x | git apply"],
  quoted: ['git -C "/tmp/some dir" commit -m "x"'],
  // Clustered single-dash flags: `-lc` is `-l` plus `-c`, so the next token is
  // still a command line.
  clusteredShellFlags: [
    'bash -lc "git push"',
    "bash -ic 'git push'",
    "bash -lic 'git push'",
    "zsh -lc 'git push'",
    "sh -cx 'git push'",
    "sh -exc 'git push'",
  ],
  plainShellFlags: [
    "sh -c 'git push'",
    "bash -c 'git push'",
    "zsh -c 'git push'",
    "bash --login -c 'git push'",
    "bash -o pipefail -c 'git push'",
    "sh -e -c 'git push'",
    "sh -c \"sh -c 'git push'\"",
  ],
  // An expansion the hook cannot evaluate, next to the name of a mutating
  // subcommand: unresolvable, therefore denied.
  expansions: [
    "$(which git) commit",
    "git $IFS commit",
    "x=commit; git $x -m y",
    "git ${x:-commit} -m y",
    "git${IFS}commit -m x",
    "`git push`",
    "echo `git commit -m x`",
  ],
  // Wrappers run the command that follows them, so the git word behind one is
  // still an invocation.
  wrappers: [
    "env git push",
    "env GIT_DIR=/tmp/x git push",
    "sudo git push",
    "command git push",
    "exec git push",
    "nohup git push",
    "time git push",
    "nice git push",
    "timeout 5 git push",
    "timeout -k 1 5 git push",
    "nice -n 5 git push",
    "sudo -n git push",
    "sudo -u ci git push",
    "xargs git commit",
    "xargs -n 1 git commit",
    "eval git commit",
    "\\git commit",
    "/usr/bin/git commit",
    "GIT_DIR=x git commit",
  ],
  // A one-shot alias makes git run a subcommand whose name is nowhere in the
  // command line, so no deny list can see it.
  inlineAliases: [
    "git -c alias.p=push p",
    "git -c alias.st=status st",
    "git -c ALIAS.p=push p",
    'git -c "alias.p=push" p',
    "git -C /tmp/x -c alias.p=push p",
    "git --config-env=alias.p=EV p",
    "git --config-env alias.p=EV p",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p",
    "GIT_CONFIG_PARAMETERS=\"'alias.p=push'\" git p",
  ],
  // `eval <string>` is `sh -c <string>` by another name: the argument has to be
  // re-parsed, or it only gets caught when its tokens happen to survive.
  evalStrings: [
    'eval "git commit -m x"',
    "eval 'git push'",
    'eval "git -C /x reset --hard"',
    "eval \"eval 'git commit'\"",
    "eval \"$(printf 'git push')\"",
    'eval "git push" # trailing comment',
    "sudo eval 'git push'",
    "sh -c \"eval 'git push'\"",
    "eval \"eval \\\"eval 'git push'\\\"\"",
  ],
  // The bare form of a subcommand whose list form is allowed.
  bareMutations: [
    "git stash",
    "git stash push -m x",
    "git stash pop",
    "git tag v1",
    "git tag -d v1",
    "git tag -a v1 -m x",
    "git worktree add ../w",
    "git worktree remove ../w",
    "git submodule update --init",
    "git submodule foreach 'git status'",
    "git notes add -m x",
    "git bisect",
    "git bisect start",
  ],
  automation: automationArgv.map(shellJoin),
};

const allDenied = Object.values(denied).flat();

/** Read-only git the loop and the agents rely on, including through expansions. */
const allowed = {
  reads: [
    "git diff HEAD -- src/ResetPassword.cs",
    "git -C /tmp/x status --porcelain",
    "git rev-parse HEAD",
    "git log --oneline -5",
    "git branch --show-current",
    "git config --get user.name",
    "git remote -v",
    // Only an `alias.*` value is refused; the rest of `-c` still works.
    "git -c core.pager=cat log --oneline",
    "git -c core.hooksPath=/dev/null status",
    "sh -c \"sh -c 'git status'\"",
    "eval 'git status --porcelain'",
    'eval "git -C /tmp/x diff HEAD"',
  ],
  // Same read/write discrimination `config`, `remote` and `branch` already had.
  listForms: [
    "git stash list",
    "git stash show",
    "git tag",
    "git tag --list",
    "git tag -l 'v*'",
    "git tag --contains HEAD",
    "git worktree list",
    "git worktree list --porcelain",
    "git submodule",
    "git submodule status",
    "git notes",
    "git notes list",
    "git notes show HEAD",
    "git bisect log",
    "git bisect view",
  ],
  help: ["git commit --help", "git push -h", "git stash --help", "git help commit"],
  // A git word that is an argument or a quoted mention, not an invocation.
  nonGit: [
    "echo git push",
    'echo "git push"',
    "rg git commit src",
    "grep -rn git push .",
    "cat x | grep git commit",
    "ls | xargs -I{} echo git add {}",
    "# git push",
    "git status # remember git commit is blocked",
    "dotnet test /p:Note=git-commit",
    "npm run finalize -- --run-id abc",
  ],
  // The expansion deny must not swallow these: no expansion in the first two,
  // no unquoted mutating subcommand in the next two, and none at all in the
  // rest. The quoted ones matter because the agents are told to write reports
  // that discuss the commands they are not allowed to run.
  expansionGuards: [
    "git log --grep=commit",
    'git status -m "commit"',
    'rg -n "git commit" "$TARGET_REPO_PATH"',
    'echo "never run git commit" >> "$RUN_DIR/notes.md"',
    'git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA"',
    'git -C "$TARGET_REPO_PATH" status --porcelain',
    'git -C "$TARGET_REPO_PATH" diff --cached -U0',
    'git -C "$TARGET_REPO_PATH" rev-parse HEAD',
    'git -C "$TARGET_REPO_PATH" show "HEAD:$FILE"',
    'git -C "$TARGET_REPO_PATH" diff --stat "$BASELINE_SHA"',
    'git -C "$TARGET_REPO_PATH" ls-files --others --exclude-standard',
    'git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA" > "$RUN_DIR/round-1-pre-commit.diff"',
  ],
};

describe("hooks.json", () => {
  it("registers one fail-closed beforeShellExecution hook that exists on disk", () => {
    const entry = readHookEntry();
    assert.equal(entry.failClosed, true);
    assert.ok(fs.existsSync(path.join(root, entry.command)), `hook command ${entry.command} does not exist`);
  });

  it("bounds the hook with an explicit timeout", () => {
    assert.equal(readHookEntry().timeout, 5);
  });

  it("registers a matcher that reaches every command the hook has to judge", () => {
    // The matcher is a regex tested unanchored against the whole command line,
    // and "" matches everything. A literal such as "git " never fires for
    // `git\tcommit` or `$(which git) commit`, and failClosed cannot help
    // because nothing failed: the hook is simply not consulted. The script
    // allows all read-only git and all non-git commands, so matching
    // everything costs one cheap process spawn.
    const matcher = readHookEntry().matcher ?? "";
    const pattern = new RegExp(matcher);
    assert.ok(pattern.test(""), `matcher ${JSON.stringify(matcher)} does not match every command`);
    for (const command of allDenied) {
      assert.ok(pattern.test(command), `matcher ${JSON.stringify(matcher)} never fires for ${command}`);
    }
  });
});

describe("block-git-writes: the loop keeps working", () => {
  it("allows every git command the .cursor prompts instruct an agent to run", () => {
    const commands = promptGitCommands();
    assert.ok(commands.length >= 4, `extraction found only ${commands.length} commands; check the matcher`);
    for (const command of commands) {
      assert.equal(decide(command), "allow", `prompts tell an agent to run a blocked command: ${command}`);
    }
  });

  it("allows the helpers that own clone, commit, and push", () => {
    // These run git through spawnSync inside the tsx process, so the hook never
    // sees their git calls and the pull request still gets opened.
    assert.equal(decide("npm run finalize -- --run-id abc"), "allow");
    assert.equal(decide("npm run prepare-repo -- --repo my-repo"), "allow");
  });

  it("allows read-only git, including a path that merely contains a denied word", () => {
    for (const command of allowed.reads) {
      assert.equal(decide(command), "allow", `must allow ${command}`);
    }
  });

  it("allows the read-only form of a subcommand whose bare form writes", () => {
    for (const command of allowed.listForms) {
      assert.equal(decide(command), "allow", `must allow ${command}`);
    }
  });

  it("allows documentation, whichever spelling", () => {
    for (const command of allowed.help) {
      assert.equal(decide(command), "allow", `must allow ${command}`);
    }
  });

  it("allows a line that only mentions git, in any position but the command one", () => {
    for (const command of allowed.nonGit) {
      assert.equal(decide(command), "allow", `must allow ${command}`);
    }
  });

  it("allows a read whose arguments are expansions", () => {
    for (const command of allowed.expansionGuards) {
      assert.equal(decide(command), "allow", `must allow ${command}`);
    }
  });

  it("runs the same way through the sh wrapper", () => {
    assert.equal(run(JSON.stringify({ command: "git status" }), ["sh", hookWrapper]).permission, "allow");
    assert.equal(run(JSON.stringify({ command: "git push" }), ["sh", hookWrapper]).permission, "deny");
  });

  it("still decides when its own path goes through a symlink", () => {
    // Node realpaths import.meta.url but not argv[1]. Comparing them raw made
    // the process exit with empty stdout, which failClosed turns into a deny of
    // every git command — including every read the three agents make.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-symlink-"));
    try {
      const linkedDir = path.join(dir, "hooks");
      fs.symlinkSync(hookDir, linkedDir);
      const linkedFile = path.join(dir, "block-git-writes.mjs");
      fs.symlinkSync(hookScript, linkedFile);
      for (const entry of [path.join(linkedDir, "block-git-writes.mjs"), linkedFile]) {
        assert.equal(run(JSON.stringify({ command: "git push" }), [process.execPath, entry]).permission, "deny");
        assert.equal(run(JSON.stringify({ command: "git status" }), [process.execPath, entry]).permission, "allow");
      }
      assert.equal(run(JSON.stringify({ command: "git push" }), ["sh", path.join(linkedDir, "block-git-writes.sh")]).permission, "deny");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("block-git-writes: mutations are blocked", () => {
  it("denies the mutating subcommands", () => {
    for (const command of denied.subcommands) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a mutation chained behind a read", () => {
    for (const command of denied.chained) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a mutation hidden behind quoting", () => {
    for (const command of denied.quoted) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a mutation behind a nested shell, clustered flags included", () => {
    for (const command of [...denied.plainShellFlags, ...denied.clusteredShellFlags]) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a mutation in an eval string, quoted or not", () => {
    for (const command of denied.evalStrings) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a subcommand smuggled through a one-shot alias", () => {
    // `git -c alias.p=push p` needs no config write and no existing alias, and
    // the subcommand that runs is never written down. Read-only alias targets
    // are refused on the same terms: nothing legitimate needs a one-shot alias.
    for (const command of denied.inlineAliases) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a line that mixes an expansion with the name of a mutation", () => {
    for (const command of denied.expansions) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies a mutation run through a wrapper", () => {
    for (const command of denied.wrappers) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies the writing form of a subcommand whose list form is allowed", () => {
    for (const command of denied.bareMutations) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("denies the automation's own git argv, which is why it must not use a shell", () => {
    // finalize and prepare-repo call spawnSync("git", args, { shell: false }),
    // so the hook never sees these. Routing them through a shell would block
    // the commit, the push, and therefore the pull request.
    for (const command of denied.automation) {
      assert.equal(decide(command), "deny", `must deny ${command}`);
    }
  });

  it("fails closed on a payload it cannot read", () => {
    assert.equal(run("not json").permission, "deny");
    assert.equal(run(JSON.stringify({ cwd: root })).permission, "deny");
  });

  it("explains itself to the user", () => {
    const denied = run(JSON.stringify({ command: "git commit -m x" }));
    assert.equal(denied.permission, "deny");
    assert.match(denied.message, /git commit/);
  });
});

describe("block-git-writes: quoting constructs cannot hide git", () => {
  it("denies a mutation hidden behind ANSI-C hex escapes", () => {
    assert.equal(decide("$" + "'\\x67it' commit -m x"), "deny");
  });

  it("decodes mixed hex and plain text in ANSI-C quoting", () => {
    assert.equal(decide("$" + "'gi\\x74' status"), "allow");
    assert.equal(decide("$" + "'\\x67it' push origin main"), "deny");
  });

  it("allows a single ANSI-C word that only mentions git commit", () => {
    // Decoding yields one token "git commit", not an invocation: commandWordIndex
    // requires the token to equal "git" exactly, so a quoted mention is not two args.
    assert.equal(decide("$'git commit'"), "allow");
  });

  it("fails closed on an unterminated ANSI-C string", () => {
    assert.equal(decide("$" + "'\\x67it push"), "deny");
  });

  it("fails closed on locale-translation quoting", () => {
    assert.equal(decide("$" + '"git" commit -m x'), "deny");
  });

  it("decodes ANSI-C escapes rather than leaving them literal", async () => {
    const { parseCommand } = (await import(pathToFileURL(hookScript).href)) as {
      parseCommand: (command: string) => { segments: string[][] } | null;
    };
    const parsed = parseCommand("$" + "'a\\nb'");
    assert.ok(parsed !== null);
    assert.equal(parsed.segments[0]?.[0], "a\nb");
  });

  it("allows an innocuous ANSI-C string", () => {
    assert.equal(decide("echo $'it works'"), "allow");
  });
});
