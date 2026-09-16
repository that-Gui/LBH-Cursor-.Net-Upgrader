#!/usr/bin/env node
// beforeShellExecution hook: refuse any git invocation that would mutate a
// repository. Agent frontmatter has no per-agent bash deny list, so this hook
// is the hard stop for direct shell git. It fails closed: anything it cannot
// parse, and anything an expansion could be hiding, is denied.
//
// It does not stop an interpreter the agent asks to run a mutation for it
// (`sh <script>`, `node -e`, `make push`); nothing static can. The prompts
// carry that rule in prose.
//
// Only the decision is here; the upgrader's own helpers (prepare/finalize) run
// git through spawnSync with shell:false inside the tsx process, so this hook
// never sees them and commit/push/clone keep working.

import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Subcommands that write to a repository, matched as exact tokens. The ones
 * that also have read-only forms (`stash list`, `tag --list`, …) are refined
 * by the predicates below; the rest are denied outright.
 */
const DENIED = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "filter-branch",
  "gc",
  "init",
  "merge",
  "mv",
  "notes",
  "push",
  "rebase",
  "replace",
  "reset",
  "restore",
  "revert",
  "rm",
  "sparse-checkout",
  "stash",
  "submodule",
  "switch",
  "tag",
  "update-ref",
  "worktree",
]);

/** Subcommands whose read-only forms are allowed, so the name alone decides nothing. */
const REFINED = new Set(["bisect", "branch", "config", "notes", "remote", "stash", "submodule", "tag", "worktree"]);

/** git global options that take a separate value and precede the subcommand. */
const GLOBAL_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

/** git global options that stand alone. */
const GLOBAL_FLAGS = new Set([
  "--no-pager",
  "--paginate",
  "--no-paginate",
  "-p",
  "-P",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--no-replace-objects",
  "--no-optional-locks",
  "--bare",
  "--exec-path",
]);

const HELP_FLAGS = new Set(["-h", "--help"]);

const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l"]);
const CONFIG_READ_SUBCOMMANDS = new Set(["get", "list"]);
const REMOTE_READ_ARGS = new Set(["-v", "--verbose", "show", "get-url"]);
const BRANCH_LIST_FLAGS = new Set([
  "--show-current",
  "--list",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--contains",
  "--merged",
  "--no-merged",
]);
const BRANCH_LIST_VALUE_FLAGS = new Set(["--contains", "--merged", "--no-merged"]);
const BRANCH_LIST_PREFIXES = ["--format=", "--sort="];

const STASH_READ_ARGS = new Set(["list", "show"]);
const SUBMODULE_READ_ARGS = new Set(["status", "summary"]);
const NOTES_READ_ARGS = new Set(["list", "show", "get-ref"]);
const BISECT_READ_ARGS = new Set(["log", "view", "visualize"]);
const WORKTREE_READ_ARGS = new Set(["list"]);

const TAG_LIST_FLAGS = new Set([
  "-l",
  "--list",
  "-n",
  "-i",
  "--ignore-case",
  "--column",
  "--no-column",
  "--omit-empty",
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
]);
const TAG_LIST_VALUE_FLAGS = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);
const TAG_LIST_PREFIXES = ["--format=", "--sort=", "--contains=", "--no-contains=", "--merged=", "--no-merged=", "--points-at=", "-n"];

/** Shells whose `-c <string>` argument is itself a command line to inspect. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "busybox"]);

/**
 * Commands that run another command, so the git word sits behind them rather
 * than at the head of the segment. Without this list, anchoring the git word to
 * the command position would let `xargs git commit` and `eval git commit`
 * through; with it, `echo git push` and `rg git commit src` stay allowed.
 */
const WRAPPERS = new Set([
  "command",
  "env",
  "eval",
  "exec",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);

/** Shell syntax words that can precede a command inside a compound statement. */
const SYNTAX_WORDS = new Set(["!", "{", "}", "do", "elif", "else", "fi", "if", "then", "until", "while"]);

/** Options of the wrappers above that consume the next token as their value. */
const WRAPPER_VALUE_OPTIONS = new Set([
  "-C",
  "-E",
  "-I",
  "-L",
  "-P",
  "-a",
  "-d",
  "-g",
  "-i",
  "-k",
  "-n",
  "-p",
  "-s",
  "-t",
  "-u",
  "--chdir",
  "--kill-after",
  "--max-args",
  "--max-procs",
  "--replace",
  "--signal",
  "--unset",
]);

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^[0-9]+(\.[0-9]+)?[smhd]?$/;

/**
 * A one-shot alias makes git run a subcommand whose name never appears on the
 * command line: `git -c alias.p=push p` is a push. Section names are
 * case-insensitive to git.
 */
const ALIAS_CONFIG = /^alias\./i;
const ALIAS_ENV_ASSIGNMENT = /^(GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_PARAMETERS)=/;

const MAX_NESTED_SHELL_DEPTH = 3;

/** One-character bash ANSI-C escapes (`\\`, `\n`, `\'`, …). */
const ANSI_C_SIMPLE = {
  "\\": "\\",
  a: "\x07",
  b: "\x08",
  e: "\x1b",
  E: "\x1b",
  f: "\x0c",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\x0b",
  "'": "'",
  '"': '"',
};

/**
 * Decode bash ANSI-C quoting (`$'...'`) starting after the opening `$'`.
 * Returns null when the construct is unterminated, including a trailing
 * backslash at the end of the command.
 *
 * @param {string} command
 * @param {number} start index of the first character after `$'`
 * @returns {{ text: string; nextIndex: number } | null}
 */
function decodeAnsiCQuote(command, start) {
  let text = "";
  let i = start;
  while (i < command.length) {
    const c = command[i];
    if (c === "'") return { text, nextIndex: i + 1 };
    if (c !== "\\") {
      text += c;
      i += 1;
      continue;
    }
    if (i + 1 >= command.length) return null;
    const e = command[i + 1] ?? "";
    i += 2;
    const simple = ANSI_C_SIMPLE[e];
    if (simple !== undefined) {
      text += simple;
      continue;
    }
    if (e === "c") {
      const x = command[i];
      if (x === undefined) return null;
      i += 1;
      text += String.fromCharCode(x.charCodeAt(0) & 0x1f);
      continue;
    }
    if (e === "x" || e === "u" || e === "U") {
      const hex = takeHexDigits(command, i, e === "x" ? 2 : e === "u" ? 4 : 8);
      if (hex.length === 0) {
        text += "\\" + e;
        continue;
      }
      const code = parseInt(hex, 16);
      if (e !== "x" && code > 0x10ffff) return null;
      text += e === "x" ? String.fromCharCode(code) : String.fromCodePoint(code);
      i += hex.length;
      continue;
    }
    if (/[0-7]/.test(e)) {
      let oct = e;
      while (oct.length < 3 && i < command.length && /[0-7]/.test(command[i] ?? "")) {
        oct += command[i];
        i += 1;
      }
      text += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    text += "\\" + e;
  }
  return null;
}

/**
 * @param {string} command
 * @param {number} start
 * @param {number} max
 */
function takeHexDigits(command, start, max) {
  let hex = "";
  while (hex.length < max) {
    const h = command[start + hex.length];
    if (h === undefined || !/[0-9A-Fa-f]/.test(h)) break;
    hex += h;
  }
  return hex;
}

/**
 * Split a command line into segments of tokens, respecting quotes and breaking
 * on the operators that start a new command: `&&`, `||`, `;`, `|`, newlines,
 * subshells, and command substitutions (`$(` and backticks, including inside
 * double quotes, where a shell would still expand them). `#` comments are
 * dropped the way a shell drops them.
 *
 * Each token is reported twice: `text` is its literal value, and `bare` is the
 * part of it that was not quoted at all, which is what the expansion check
 * below reasons about — a quoted `"git commit"` is a mention being searched
 * for or written to a report, not an invocation.
 *
 * Segments are also flagged when a substitution is what ended them, because a
 * segment cut off mid-argument is one whose arguments are partly unknowable.
 *
 * @param {string} command
 * @returns {{ segments: string[][]; bare: string[][]; cut: boolean[]; dynamic: boolean } | null} null when the line cannot be parsed.
 */
export function parseCommand(command) {
  /** @type {string[][]} */
  const segments = [];
  /** @type {string[][]} */
  const bareSegments = [];
  /** @type {boolean[]} */
  const cutSegments = [];
  /** @type {string[]} */
  let tokens = [];
  /** @type {string[]} */
  let bareTokens = [];
  let current = "";
  let currentBare = "";
  let started = false;
  let dynamic = false;
  /** @type {("'" | '"' | null)} */
  let quote = null;
  /** @type {{ kind: "paren" | "backtick"; quote: "'" | '"' | null }[]} */
  const nesting = [];
  let i = 0;

  const endToken = () => {
    if (started) {
      tokens.push(current);
      bareTokens.push(currentBare);
      current = "";
      currentBare = "";
      started = false;
    }
  };
  /** @param {boolean} [cut] true when a substitution is what ended the segment. */
  const endSegment = (cut = false) => {
    endToken();
    if (tokens.length > 0) {
      segments.push(tokens);
      bareSegments.push(bareTokens);
      cutSegments.push(cut);
    }
    tokens = [];
    bareTokens = [];
  };
  /** @param {string} c */
  const append = (c) => {
    current += c;
    if (quote === null) currentBare += c;
    started = true;
  };

  while (i < command.length) {
    const c = command[i];

    if (quote === "'") {
      if (c === "'") quote = null;
      else append(c);
      started = true;
      i += 1;
      continue;
    }

    if (c === "\\" && i + 1 < command.length) {
      append(command[i + 1] ?? "");
      i += 2;
      continue;
    }

    // $'...' is static ANSI-C quoting: decode it so git cannot hide behind
    // $'\x67it'. $"..." is locale translation and expands variables, so it is
    // not static — fail closed. Git's name must not be hideable behind a
    // quoting construct.
    if (quote === null && c === "$") {
      const next = command[i + 1];
      if (next === "'") {
        const decoded = decodeAnsiCQuote(command, i + 2);
        if (decoded === null) return null;
        current += decoded.text;
        started = true;
        i = decoded.nextIndex;
        continue;
      }
      if (next === '"') return null;
    }

    // A parameter expansion or a bare variable reference: the literal tokens
    // stop being trustworthy from here on.
    if (c === "$") {
      const next = command[i + 1];
      if (next === "{" || (next !== undefined && /[A-Za-z_]/.test(next))) dynamic = true;
    }

    if (c === "$" && command[i + 1] === "(") {
      dynamic = true;
      endSegment(true);
      nesting.push({ kind: "paren", quote });
      quote = null;
      i += 2;
      continue;
    }

    if (c === "`") {
      dynamic = true;
      endSegment(true);
      const top = nesting[nesting.length - 1];
      if (top !== undefined && top.kind === "backtick") {
        nesting.pop();
        quote = top.quote;
      } else {
        nesting.push({ kind: "backtick", quote });
        quote = null;
      }
      i += 1;
      continue;
    }

    if (quote === '"') {
      if (c === '"') quote = null;
      else append(c);
      started = true;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      i += 1;
      continue;
    }

    if (c === ")") {
      endSegment();
      const top = nesting.pop();
      if (top === undefined) return null;
      quote = top.quote;
      i += 1;
      continue;
    }

    if (c === "(") {
      endSegment();
      nesting.push({ kind: "paren", quote });
      i += 1;
      continue;
    }

    if (c === "#" && !started) {
      while (i < command.length && command[i] !== "\n") i += 1;
      continue;
    }

    if (c === "&" || c === "|" || c === ";" || c === "\n") {
      endSegment();
      while (i < command.length && command[i] === c) i += 1;
      continue;
    }

    if (c === " " || c === "\t" || c === "\r") {
      endToken();
      i += 1;
      continue;
    }

    append(c ?? "");
    i += 1;
  }

  if (quote !== null || nesting.length > 0) return null;
  endSegment();
  return { segments, bare: bareSegments, cut: cutSegments, dynamic };
}

/** @param {string} token */
function basenameOf(token) {
  return token.split(/[/\\]/).pop() ?? "";
}

/** @param {string} token */
function isGitWord(token) {
  const base = basenameOf(token);
  return base === "git" || base === "git.exe";
}

/** @param {string} token */
function isEvalWord(token) {
  return basenameOf(token) === "eval";
}

/**
 * Locate a command word: leading `VAR=value` assignments, shell syntax words,
 * and the wrappers above may precede it, but a token anywhere else (`echo git
 * push`, `rg git commit src`) is an argument, not an invocation.
 *
 * @param {string[]} tokens
 * @param {(token: string) => boolean} isWanted
 * @returns {number} -1 when the segment does not run the wanted command.
 */
function commandWordIndex(tokens, isWanted) {
  let wrapped = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) return -1;
    if (isWanted(token)) return i;
    if (ASSIGNMENT.test(token)) continue;
    if (SYNTAX_WORDS.has(token)) continue;
    if (WRAPPERS.has(basenameOf(token))) {
      wrapped = true;
      continue;
    }
    if (!wrapped) return -1;
    // Inside a wrapper's own arguments: its options and their values may sit
    // between it and the command it runs. The same short option means
    // different things to different wrappers (`nice -n 5` takes a value,
    // `sudo -n` does not), so never step over the command word itself.
    if (WRAPPER_VALUE_OPTIONS.has(token)) {
      const next = tokens[i + 1];
      if (next !== undefined && !isWanted(next)) i += 1;
      continue;
    }
    if (token.startsWith("-") || DURATION.test(token)) continue;
    return -1;
  }
  return -1;
}

/**
 * A `-c alias.x=<subcommand>` (or its `--config-env` and `GIT_CONFIG_*` twins)
 * defines an alias for the length of one invocation, so the subcommand that
 * runs is not the one on the command line: `git -c alias.p=push p` pushes, and
 * `p` is in no deny list. No read-only work needs a one-shot alias, so any
 * `alias.*` in that position is refused rather than resolved — resolving it
 * would mean chasing an alias whose own value can chain (`!git push`, `p q`)
 * or come from the environment.
 *
 * Config that merely *points* at a file which defines aliases
 * (`-c include.path=…`, `GIT_CONFIG_GLOBAL=…`, `HOME=…`) is not covered: that
 * needs a config file planted first, which puts it in the same
 * cannot-be-prevented class as `./push.sh`.
 *
 * @param {string[]} tokens
 * @param {number} gitIndex
 * @returns {string | undefined}
 */
function aliasReason(tokens, gitIndex) {
  for (let i = 0; i < gitIndex; i += 1) {
    const token = tokens[i] ?? "";
    if (ALIAS_ENV_ASSIGNMENT.test(token) && /alias\./i.test(token)) return "git (subcommand defined by an inline alias)";
  }
  for (let i = gitIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token === "-c" || token === "--config-env") {
      if (ALIAS_CONFIG.test(tokens[i + 1] ?? "")) return "git (subcommand defined by an inline alias)";
      i += 1;
      continue;
    }
    if (token.startsWith("--config-env=") && ALIAS_CONFIG.test(token.slice("--config-env=".length))) {
      return "git (subcommand defined by an inline alias)";
    }
  }
  return undefined;
}

/**
 * Locate the subcommand of a git invocation, skipping git's global options.
 *
 * @param {string[]} tokens
 * @param {number} gitIndex
 * @returns {{ name: string; index: number } | undefined}
 */
function subcommandOf(tokens, gitIndex) {
  for (let i = gitIndex + 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) return undefined;
    if (GLOBAL_VALUE_OPTIONS.has(token)) {
      i += 1;
      continue;
    }
    if (GLOBAL_FLAGS.has(token)) continue;
    if (token.startsWith("-")) continue;
    return { name: token, index: i };
  }
  return undefined;
}

/**
 * Scan arguments against a read-only vocabulary.
 *
 * @param {string[]} args
 * @param {{ flags: Set<string>; valueFlags?: Set<string>; prefixes?: string[]; operands?: boolean }} vocabulary
 */
function argsAreRead(args, { flags, valueFlags = new Set(), prefixes = [], operands = false }) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) return false;
    if (valueFlags.has(arg)) {
      i += 1;
      continue;
    }
    if (flags.has(arg)) continue;
    if (prefixes.some((prefix) => arg.startsWith(prefix))) continue;
    if (operands && !arg.startsWith("-")) continue;
    return false;
  }
  return true;
}

/**
 * @param {string[]} args arguments after `git config`
 */
function configIsRead(args) {
  const writes = ["--add", "--unset", "--unset-all", "--replace-all", "--edit", "-e", "--remove-section", "--rename-section", "set", "unset", "edit"];
  if (args.some((a) => writes.includes(a))) return false;
  const first = args[0];
  if (first !== undefined && CONFIG_READ_SUBCOMMANDS.has(first)) return true;
  return args.some((a) => CONFIG_READ_FLAGS.has(a) || a.startsWith("--get-regexp="));
}

/**
 * @param {string[]} args arguments after `git remote`
 */
function remoteIsRead(args) {
  const first = args[0];
  return first === undefined || REMOTE_READ_ARGS.has(first);
}

/**
 * @param {string[]} args arguments after `git branch`
 */
function branchIsList(args) {
  return argsAreRead(args, { flags: BRANCH_LIST_FLAGS, valueFlags: BRANCH_LIST_VALUE_FLAGS, prefixes: BRANCH_LIST_PREFIXES });
}

/**
 * `git stash` with no argument stashes, so only the explicit read arguments
 * are allowed here.
 *
 * @param {string[]} args arguments after `git stash`
 */
function stashIsRead(args) {
  const first = args[0];
  return first !== undefined && STASH_READ_ARGS.has(first);
}

/**
 * Bare `git tag` lists tags; a tag name or `-d` writes one. A pattern is an
 * operand of `-l`, so operands count as read-only once a list flag is present.
 *
 * @param {string[]} args arguments after `git tag`
 */
function tagIsRead(args) {
  if (args.length === 0) return true;
  const lists = args.some((a) => TAG_LIST_FLAGS.has(a) || TAG_LIST_PREFIXES.some((prefix) => a.startsWith(prefix)));
  if (!lists) return false;
  return argsAreRead(args, { flags: TAG_LIST_FLAGS, valueFlags: TAG_LIST_VALUE_FLAGS, prefixes: TAG_LIST_PREFIXES, operands: true });
}

/**
 * @param {string[]} args arguments after `git worktree`
 */
function worktreeIsRead(args) {
  const first = args[0];
  return first !== undefined && WORKTREE_READ_ARGS.has(first);
}

/**
 * Bare `git submodule` lists; `foreach` runs arbitrary commands, so it is not
 * a read.
 *
 * @param {string[]} args arguments after `git submodule`
 */
function submoduleIsRead(args) {
  const first = args[0];
  return first === undefined || SUBMODULE_READ_ARGS.has(first);
}

/**
 * Bare `git notes` lists.
 *
 * @param {string[]} args arguments after `git notes`
 */
function notesIsRead(args) {
  const first = args[0];
  return first === undefined || NOTES_READ_ARGS.has(first);
}

/**
 * @param {string[]} args arguments after `git bisect`
 */
function bisectIsRead(args) {
  const first = args[0];
  return first !== undefined && BISECT_READ_ARGS.has(first);
}

/**
 * `git <subcommand> --help` prints documentation, exactly like the already
 * allowed `git help <subcommand>`. Only the leading position counts: git
 * treats `-h` after an option that wants a value (`git commit -m -h`) as that
 * value and goes on to commit.
 *
 * @param {string[]} args
 */
function isHelpRequest(args) {
  const first = args[0];
  return first !== undefined && HELP_FLAGS.has(first);
}

/**
 * @param {string} subcommand
 * @param {string[]} args arguments after the subcommand
 * @returns {string | undefined} a reason when the invocation must be denied.
 */
function denyReason(subcommand, args) {
  if (isHelpRequest(args)) return undefined;
  switch (subcommand) {
    case "bisect":
      return bisectIsRead(args) ? undefined : "git bisect (write)";
    case "branch":
      return branchIsList(args) ? undefined : "git branch (write)";
    case "config":
      return configIsRead(args) ? undefined : "git config (write)";
    case "notes":
      return notesIsRead(args) ? undefined : "git notes (write)";
    case "remote":
      return remoteIsRead(args) ? undefined : "git remote (write)";
    case "stash":
      return stashIsRead(args) ? undefined : "git stash (write)";
    case "submodule":
      return submoduleIsRead(args) ? undefined : "git submodule (write)";
    case "tag":
      return tagIsRead(args) ? undefined : "git tag (write)";
    case "worktree":
      return worktreeIsRead(args) ? undefined : "git worktree (write)";
    default:
      return DENIED.has(subcommand) ? `git ${subcommand}` : undefined;
  }
}

/** Word characters for the ambiguity scan: paths stay whole, `${x:-commit}` does not. */
const EXPANSION_PUNCTUATION = /[^A-Za-z0-9_./-]+/;

/**
 * A command line that mixes an expansion with the name of a mutating
 * subcommand cannot be checked: `$(which git) commit`, `git $x -m y` and
 * `git${IFS}commit` all tokenise to something harmless while running a
 * mutation. Deny instead of guessing.
 *
 * Gated on four things at once, so ordinary reads survive: an expansion must be
 * present, and an unquoted git word and an unquoted subcommand with no
 * read-only form must both be named outside any option. That leaves
 * `git -C "$TARGET_REPO_PATH" diff "$BASELINE_SHA"`, `git log --grep=commit`
 * and `echo "never run git commit" >> "$RUN_DIR/notes.md"` alone.
 *
 * @param {{ bare: string[][]; dynamic: boolean }} parsed
 * @returns {string | undefined}
 */
function expansionReason(parsed) {
  if (!parsed.dynamic) return undefined;
  /** @type {string[]} */
  const words = [];
  for (const segment of parsed.bare) {
    for (const token of segment) {
      if (token.startsWith("-")) continue;
      for (const piece of token.split(EXPANSION_PUNCTUATION)) {
        const word = piece.replace(/^-+/, "");
        if (word !== "") words.push(word);
      }
    }
  }
  if (!words.some(isGitWord)) return undefined;
  const hidden = words.find((word) => DENIED.has(word) && !REFINED.has(word));
  return hidden === undefined ? undefined : `git ${hidden} (hidden by a shell expansion)`;
}

/**
 * Decide whether a shell command may run.
 *
 * @param {unknown} command
 * @param {number} [depth]
 * @returns {{ permission: "allow" | "deny"; reason?: string }}
 */
export function decide(command, depth = 0) {
  if (typeof command !== "string") return { permission: "deny", reason: "no command string in the hook payload" };

  const parsed = parseCommand(command);
  if (parsed === null) return { permission: "deny", reason: "the command line could not be parsed" };

  for (const [index, tokens] of parsed.segments.entries()) {
    const gitIndex = commandWordIndex(tokens, isGitWord);
    if (gitIndex !== -1) {
      const alias = aliasReason(tokens, gitIndex);
      if (alias !== undefined) return { permission: "deny", reason: alias };
      const subcommand = subcommandOf(tokens, gitIndex);
      if (subcommand !== undefined && !isHelpRequest(tokens.slice(gitIndex + 1, subcommand.index))) {
        const reason = denyReason(subcommand.name, tokens.slice(subcommand.index + 1));
        if (reason !== undefined) return { permission: "deny", reason };
      }
    }

    // `eval <string>` and `sh -c <string>` are the same problem: the argument
    // is a command line, so it has to be parsed as one. Unquoted `eval git
    // commit` only ever worked by accident, its tokens happening to survive in
    // this segment.
    for (const nested of nestedCommands(tokens, parsed.cut[index] === true)) {
      if (nested === null) return { permission: "deny", reason: "a command line assembled by an expansion, which cannot be checked" };
      if (depth >= MAX_NESTED_SHELL_DEPTH) return { permission: "deny", reason: "the command nests command strings too deeply to be checked" };
      const inner = decide(nested, depth + 1);
      if (inner.permission === "deny") return inner;
    }
  }

  const expansion = expansionReason(parsed);
  if (expansion !== undefined) return { permission: "deny", reason: expansion };

  return { permission: "allow" };
}

/**
 * A single-dash cluster that contains `c` is the `-c` flag: `bash -lc`,
 * `sh -cx` and `sh -exc` all take the next token as a command line.
 *
 * @param {string} token
 */
function isShellCommandFlag(token) {
  return /^-[A-Za-z]*c[A-Za-z]*$/.test(token);
}

/**
 * Every command line this segment hands to another parser: the argument of
 * `sh -c "<command>"` and the argument of `eval`. A `null` entry is an
 * argument the hook cannot reconstruct because a substitution supplied part of
 * it, which the caller denies.
 *
 * @param {string[]} tokens
 * @param {boolean} cut true when a substitution ended this segment
 * @returns {(string | null)[]}
 */
function nestedCommands(tokens, cut) {
  /** @type {(string | null)[]} */
  const nested = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (!SHELLS.has(basenameOf(token))) continue;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const flag = tokens[j];
      if (flag === undefined || !isShellCommandFlag(flag)) continue;
      const argument = tokens[j + 1];
      if (argument !== undefined) nested.push(argument);
      else if (cut) nested.push(null);
      break;
    }
  }

  const evalIndex = commandWordIndex(tokens, isEvalWord);
  if (evalIndex !== -1) {
    const args = tokens.slice(evalIndex + 1);
    // Rejoining is safe because the tokens keep any inner quoting: `eval "git
    // status -m 'x y'"` is one token that re-parses to the same command line.
    if (cut || args.length === 0) nested.push(null);
    else nested.push(args.join(" "));
  }

  return nested;
}

/**
 * @param {{ permission: "allow" | "deny"; reason?: string }} decision
 */
export function toHookOutput(decision) {
  if (decision.permission === "allow") return { continue: true, permission: "allow" };
  const reason = decision.reason ?? "this command could not be checked";
  const blocked = reason.startsWith("git ") ? `Blocked \`${reason}\`` : `Blocked: ${reason}`;
  return {
    continue: true,
    permission: "deny",
    user_message: `${blocked}: agents must not mutate repository state; the upgrader's finalize helper owns commit and push.`,
    agent_message:
      `${blocked} by the workspace hook. Do not retry or work around it: report what you found instead, ` +
      "and note any change you believe needs committing. Read-only git is available: status, diff, log, show, rev-parse, " +
      "ls-files, and the list forms such as stash list, tag --list, and worktree list.",
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  let command;
  try {
    const payload = JSON.parse(await readStdin());
    command = payload?.command;
  } catch {
    command = undefined;
  }
  process.stdout.write(`${JSON.stringify(toHookOutput(decide(command)))}\n`);
  process.exit(0);
}

/**
 * Only skip main() when argv[1] is provably a different file. Node realpaths
 * `import.meta.url` but not argv[1], so comparing them raw made any invocation
 * through a symlinked path exit with empty stdout — which `failClosed` turns
 * into a deny of every git command, including the loop's reads.
 */
function importedByAnotherModule() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fs.realpathSync(entry) !== fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (!importedByAnotherModule()) {
  await main();
}
