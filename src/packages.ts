/**
 * Diff-derived dependency facts for the PR body. Everything here is a pure function over
 * two blob contents, so the PR table states what the diff says rather than what the agent
 * claims: the agent only supplies the reason column.
 */

/** Blobs above this size are not worth parsing (lock files, vendored data). */
export const MAX_MANIFEST_BYTES = 1_048_576;
/** Hard cap on rows rendered in the PR table. */
export const MAX_DEPENDENCY_ROWS = 200;

export type ChangeKind = "added" | "removed" | "changed";

export type PackageChange = {
  file: string;
  package: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type FrameworkChange = {
  file: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type SdkChange = {
  file: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type ImageChange = {
  file: string;
  image: string;
  from?: string;
  to?: string;
  kind: ChangeKind;
};

export type DependencyChanges = {
  packages: PackageChange[];
  frameworks: FrameworkChange[];
  sdks: SdkChange[];
  images: ImageChange[];
  /** Rows dropped by MAX_DEPENDENCY_ROWS. */
  omitted: number;
  /** Manifests that were too large to parse. */
  skipped: string[];
};

export function emptyDependencyChanges(): DependencyChanges {
  return { packages: [], frameworks: [], sdks: [], images: [], omitted: 0, skipped: [] };
}

export function hasDependencyChanges(changes: DependencyChanges): boolean {
  return (
    changes.packages.length > 0 ||
    changes.frameworks.length > 0 ||
    changes.sdks.length > 0 ||
    changes.images.length > 0
  );
}

export function mergeDependencyChanges(a: DependencyChanges, b: DependencyChanges): DependencyChanges {
  return {
    packages: [...a.packages, ...b.packages],
    frameworks: [...a.frameworks, ...b.frameworks],
    sdks: [...a.sdks, ...b.sdks],
    images: [...a.images, ...b.images],
    omitted: a.omitted + b.omitted,
    skipped: [...a.skipped, ...b.skipped],
  };
}

export function capDependencyChanges(
  changes: DependencyChanges,
  max = MAX_DEPENDENCY_ROWS,
): DependencyChanges {
  const total =
    changes.packages.length + changes.frameworks.length + changes.sdks.length + changes.images.length;
  if (total <= max) return changes;
  let left = max;
  const take = <T>(rows: T[]): T[] => {
    const kept = rows.slice(0, Math.max(0, left));
    left -= kept.length;
    return kept;
  };
  const packages = take(changes.packages);
  const frameworks = take(changes.frameworks);
  const sdks = take(changes.sdks);
  const images = take(changes.images);
  return {
    packages,
    frameworks,
    sdks,
    images,
    omitted: changes.omitted + (total - max),
    skipped: changes.skipped,
  };
}

const PROJECT_FILE = /\.(cs|fs|vb)proj$/i;

export function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

export function isDockerfile(p: string): boolean {
  const name = basename(p).toLowerCase();
  return name.startsWith("dockerfile") || name.endsWith(".dockerfile");
}

/**
 * Whether a path can carry a dependency the build resolves. Every `.props`/`.targets` file
 * counts, not just the well-known names: an import the repository wrote itself carries a
 * `PackageReference` exactly as `Directory.Packages.props` does, and a reference the table
 * never reads is a reference the evidence gate never asks the writer to justify.
 */
export function isPackageManifest(p: string): boolean {
  const name = basename(p).toLowerCase();
  if (!name) return false;
  if (PROJECT_FILE.test(name)) return true;
  if (isDockerfile(name)) return true;
  if (/\.(?:props|targets)$/.test(name)) return true;
  return name === "global.json" || name === "packages.lock.json" || name === "packages.config";
}

function classify(from: string | undefined, to: string | undefined): ChangeKind | undefined {
  if (from === to) return undefined;
  if (from === undefined) return "added";
  if (to === undefined) return "removed";
  return "changed";
}

function versionFields(from?: string, to?: string): { from?: string; to?: string } {
  const fields: { from?: string; to?: string } = {};
  if (from !== undefined) fields.from = from;
  if (to !== undefined) fields.to = to;
  return fields;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m);
}

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function attrValue(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const raw = m?.[1] ?? m?.[2];
  return raw === undefined ? undefined : decodeXml(raw).trim();
}

function childValue(inner: string, name: string): string | undefined {
  const m = new RegExp(`<${name}\\s*>([\\s\\S]*?)</${name}\\s*>`, "i").exec(inner);
  const raw = m?.[1];
  return raw === undefined ? undefined : decodeXml(raw).trim();
}

const PACKAGE_ELEMENT =
  /<(PackageReference|PackageVersion|GlobalPackageReference)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;

/**
 * A `packages.config` entry: `<package id="Serilog" version="2.12.0" targetFramework="net48" />`.
 * The `\b` is what keeps the `<packages>` root out — a reference the table never reads is a
 * reference the evidence gate never asks the writer to justify.
 */
const PACKAGES_CONFIG_ELEMENT = /<package\b([^>]*?)(?:\/>|>([\s\S]*?)<\/package\s*>)/gi;

/**
 * Package id -> version for `PackageReference` / `PackageVersion` / legacy `packages.config`,
 * accepting `Include=`, `Update=` or `id=` and the version as an attribute or a child element.
 * A reference with no version (central package management, or a `packages.config` entry written
 * without one) maps to the empty string, which is distinct from being absent.
 */
export function parsePackageVersions(xml: string): Map<string, string> {
  const versions = new Map<string, string>();
  const record = (id: string | undefined, version: string): void => {
    if (!id) return;
    const existing = versions.get(id);
    if (existing === undefined || (existing === "" && version !== "")) versions.set(id, version);
  };
  const text = stripComments(xml);
  for (const match of text.matchAll(PACKAGE_ELEMENT)) {
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    record(
      attrValue(attrs, "Include") ?? attrValue(attrs, "Update"),
      attrValue(attrs, "Version") ?? childValue(inner, "Version") ?? "",
    );
  }
  for (const match of text.matchAll(PACKAGES_CONFIG_ELEMENT)) {
    const attrs = match[1] ?? "";
    // `allowedVersions` and `developmentDependency` are constraints on a reference, not the
    // reference itself, and neither is a version the diff can report a move between.
    record(attrValue(attrs, "id"), attrValue(attrs, "version") ?? "");
  }
  return versions;
}

const TFM_ELEMENT = /<(TargetFrameworks?)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;

export function parseTargetFrameworks(xml: string): string[] {
  const frameworks: string[] = [];
  for (const match of stripComments(xml).matchAll(TFM_ELEMENT)) {
    for (const raw of decodeXml(match[2] ?? "").split(";")) {
      const tfm = raw.trim();
      if (tfm && !frameworks.includes(tfm)) frameworks.push(tfm);
    }
  }
  return frameworks;
}

export function parseSdkPin(json: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const sdk = (parsed as { sdk?: unknown }).sdk;
  if (typeof sdk !== "object" || sdk === null) return undefined;
  const version = (sdk as { version?: unknown }).version;
  return typeof version === "string" && version.trim() ? version.trim() : undefined;
}

function splitImageRef(ref: string): { name: string; tag: string } {
  const digest = ref.indexOf("@");
  if (digest > 0) return { name: ref.slice(0, digest), tag: ref.slice(digest + 1) };
  const colon = ref.lastIndexOf(":");
  const slash = ref.lastIndexOf("/");
  if (colon > slash && colon > 0) return { name: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { name: ref, tag: "latest" };
}

/**
 * Base image name -> the tags it is pulled at, in file order. Multi-stage builds that pull the
 * same image twice collapse into one comma-joined entry so the diff stays one row per image.
 */
export function parseDockerImages(text: string): Map<string, string> {
  const stages = new Set<string>();
  const tags = new Map<string, string[]>();
  for (const line of text.split(/\r?\n/)) {
    const from = /^\s*FROM\s+(\S.*)$/i.exec(line);
    if (!from) continue;
    const words = (from[1] ?? "").trim().split(/\s+/).filter((w) => !w.startsWith("--"));
    const ref = words[0];
    if (!ref) continue;
    const asIndex = words.findIndex((w) => w.toLowerCase() === "as");
    const stage = asIndex >= 0 ? words[asIndex + 1] : undefined;
    if (stage) stages.add(stage.toLowerCase());
    if (stages.has(ref.toLowerCase())) continue;
    const { name, tag } = splitImageRef(ref);
    const seen = tags.get(name);
    if (seen) seen.push(tag);
    else tags.set(name, [tag]);
  }
  return new Map([...tags].map(([name, list]) => [name, list.join(", ")]));
}

function diffPackages(before: string, after: string, file: string): PackageChange[] {
  const beforeVersions = parsePackageVersions(before);
  const afterVersions = parsePackageVersions(after);
  const index = (versions: Map<string, string>): Map<string, string> =>
    new Map([...versions].map(([id, v]) => [id.toLowerCase(), v]));
  const beforeIndex = index(beforeVersions);
  const afterIndex = index(afterVersions);
  const display = new Map<string, string>();
  for (const id of beforeVersions.keys()) display.set(id.toLowerCase(), id);
  for (const id of afterVersions.keys()) display.set(id.toLowerCase(), id);

  const changes: PackageChange[] = [];
  for (const [key, id] of display) {
    const from = beforeIndex.get(key);
    const to = afterIndex.get(key);
    const kind = classify(from, to);
    if (!kind) continue;
    changes.push({ file, package: id, ...versionFields(from, to), kind });
  }
  return changes;
}

function diffFrameworks(before: string, after: string, file: string): FrameworkChange[] {
  const from = parseTargetFrameworks(before);
  const to = parseTargetFrameworks(after);
  const kind = classify(from.length ? from.join("; ") : undefined, to.length ? to.join("; ") : undefined);
  if (!kind) return [];
  return [
    {
      file,
      ...versionFields(from.length ? from.join("; ") : undefined, to.length ? to.join("; ") : undefined),
      kind,
    },
  ];
}

function diffImages(before: string, after: string, file: string): ImageChange[] {
  const beforeImages = parseDockerImages(before);
  const afterImages = parseDockerImages(after);
  const names = [...new Set([...beforeImages.keys(), ...afterImages.keys()])];
  const changes: ImageChange[] = [];
  for (const image of names) {
    const from = beforeImages.get(image);
    const to = afterImages.get(image);
    const kind = classify(from, to);
    if (!kind) continue;
    changes.push({ file, image, ...versionFields(from, to), kind });
  }
  return changes;
}

/** Hard cap on reported suppressions; the gate only needs enough to name the problem. */
export const MAX_SUPPRESSIONS = 50;
/** Reported lines are clipped to this length in a suppression report. */
export const MAX_SUPPRESSION_CHARS = 120;

export type Suppression = {
  file: string;
  /** The diff line's text, whitespace-collapsed and clipped. */
  line: string;
  /** The construct that matched, for the refusal message. */
  token: string;
};

/**
 * A finding list, plus whether the cap dropped findings the scan would otherwise have reported.
 * A truncated report cannot be reasoned about: the findings it kept are the ones the diff put
 * first, diff order is alphabetical, and the writer chooses the file names — so a caller has to
 * treat truncation as a refusal rather than as a shorter list.
 */
export type Report<T> = { findings: T[]; truncated: boolean };
export type SuppressionReport = Report<Suppression>;
export type TestWeakeningReport = Report<TestWeakening>;

/** A construct to look for on one side of a file section, and where it counts as one. */
export type LinePattern = {
  token: string;
  pattern: RegExp;
  /** Further condition on the matched line, for constructs that only matter about a test path. */
  accept?: (line: string) => boolean;
  /**
   * The diagnostic ids the construct silences. Comparing whole lines is what tells a reindent
   * from a new suppression, but it cannot tell either from a suppression that grew: appending a
   * code to a `NoWarn` the file already had rewrites a line that always carried the token, so
   * the line comparison reads the most ordinary way of hiding a warning as a reformat. Where
   * this is set, a code the other side does not carry is reported however the line moved.
   */
  args?: (line: string) => string[];
};

/** `CS1591`, `SYSLIB0011`, `1591` — a diagnostic id, as against prose that shares the line. */
const DIAGNOSTIC_CODE = /^[A-Za-z]{0,12}\d{2,6}$/;

function diagnosticCodes(values: readonly string[]): string[] {
  const codes = new Set<string>();
  for (const raw of values) {
    const code = raw.trim();
    if (DIAGNOSTIC_CODE.test(code)) codes.add(code.toUpperCase());
  }
  return [...codes];
}

/**
 * The codes a list-valued MSBuild property carries, written as an element
 * (`<NoWarn>CS1591;CS0618</NoWarn>`) or as an assignment (`-p:NoWarn=CS1591`). `$(NoWarn)` is
 * not a code: a line that only prepends the inherited value silences nothing new.
 */
function listProperty(property: string): (line: string) => string[] {
  const source = `<\\s*${property}\\s*>([^<]*)|\\b${property}\\s*=\\s*"?([^"<>]*)`;
  return (line) => {
    const parts: string[] = [];
    for (const match of line.matchAll(new RegExp(source, "gi"))) {
      parts.push(...(match[1] ?? match[2] ?? "").split(/[;,]/));
    }
    return diagnosticCodes(parts);
  };
}

/** The codes a `#pragma warning disable` names, with any trailing justification comment cut. */
function pragmaCodes(line: string): string[] {
  const body = /#\s*pragma\s+warning\s+disable\b(.*)$/i.exec(line.replace(/\/\/.*$/, ""));
  return diagnosticCodes((body?.[1] ?? "").split(/[;,\s]+/));
}

/** The rule ids a `[SuppressMessage]` names: `"CA2200:Rethrow to preserve stack"` -> `CA2200`. */
function suppressMessageCodes(line: string): string[] {
  const quoted = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");
  return diagnosticCodes(quoted.map((value) => value.split(":")[0] ?? ""));
}

/**
 * Constructs that silence a diagnostic instead of fixing it. A warning that already fired
 * on the base branch was not introduced by the upgrade, so adding any of these to the diff
 * is out of scope for a retarget. The audit settings name the weakening value: raising
 * `NuGetAuditMode` to `all` or lowering `NuGetAuditLevel` to `low` tightens the build.
 */
export const SUPPRESSION_PATTERNS: readonly LinePattern[] = [
  { token: "#pragma warning disable", pattern: /#\s*pragma\s+warning\s+disable\b/i, args: pragmaCodes },
  { token: "NoWarn", pattern: /\bNoWarn\b/i, args: listProperty("NoWarn") },
  {
    token: "WarningsNotAsErrors",
    pattern: /\bWarningsNotAsErrors\b/i,
    args: listProperty("WarningsNotAsErrors"),
  },
  { token: "TreatWarningsAsErrors", pattern: /\bTreatWarningsAsErrors\s*[>=]\s*["']?\s*false\b/i },
  { token: "SuppressMessage", pattern: /\b(?:Unconditional)?SuppressMessage\s*\(/i, args: suppressMessageCodes },
  { token: "WarningLevel", pattern: /\bWarningLevel\s*[>=]\s*["']?\s*0\b/i },
  { token: "EnableNETAnalyzers", pattern: /\bEnableNETAnalyzers\s*[>=]\s*["']?\s*false\b/i },
  { token: "AnalysisLevel", pattern: /\bAnalysisLevel(?:Style|Security)?\s*[>=]\s*["']?\s*none\b/i },
  { token: "RunAnalyzers", pattern: /\bRunAnalyzers\w*\s*[>=]\s*["']?\s*false\b/i },
  { token: "Nullable", pattern: /\bNullable\s*[>=]\s*["']?\s*disable\b/i },
  {
    token: "diagnostic severity",
    pattern: /^\s*dotnet_(?:diagnostic|analyzer_diagnostic)\b[^=]*\.severity\s*=\s*(?:none|silent|suggestion|info)\b/i,
  },
  { token: "NuGetAudit", pattern: /\bNuGetAudit\s*[>=]\s*["']?\s*false\b/i },
  { token: "NuGetAuditMode", pattern: /\bNuGetAuditMode\s*[>=]\s*["']?\s*direct\b/i },
  { token: "NuGetAuditLevel", pattern: /\bNuGetAuditLevel\s*[>=]\s*["']?\s*(?:moderate|high|critical)\b/i },
];

/**
 * Settings whose removal is the same act as setting them to their weak value: a build with no
 * `TreatWarningsAsErrors` is a build that tolerates warnings, however the property left.
 */
export const STRICTNESS_REMOVAL_PATTERNS: readonly LinePattern[] = [
  { token: "TreatWarningsAsErrors", pattern: /<\s*TreatWarningsAsErrors\s*>\s*true\b/i },
  { token: "EnableNETAnalyzers", pattern: /<\s*EnableNETAnalyzers\s*>\s*true\b/i },
  { token: "RunAnalyzers", pattern: /<\s*RunAnalyzers\w*\s*>\s*true\b/i },
  { token: "Nullable", pattern: /<\s*Nullable\s*>\s*(?:enable|warnings)\b/i },
  { token: "NuGetAudit", pattern: /<\s*NuGetAudit\s*>\s*true\b/i },
  {
    token: "diagnostic severity",
    pattern: /^\s*dotnet_(?:diagnostic|analyzer_diagnostic)\b[^=]*\.severity\s*=\s*(?:error|warning)\b/i,
  },
];

/** Hard cap on reported test weakenings; the gate only needs enough to name the problem. */
export const MAX_TEST_WEAKENINGS = 50;
/** Reported lines are clipped to this length in a test-weakening report. */
export const MAX_TEST_WEAKENING_CHARS = 120;

export type TestWeakening = {
  file: string;
  /** The diff line's text, whitespace-collapsed and clipped. */
  line: string;
  /** The construct that matched, for the refusal message. */
  token: string;
};

/** Extensions the compiler reads: a test renamed off this list is no longer in the build. */
const COMPILED_SOURCE = /\.(?:cs|fs|vb)$/i;
/** Files that carry the test plumbing rather than the tests: projects, imports, solutions. */
const BUILD_FILE = /\.(?:(?:cs|fs|vb)proj|props|targets|sln|slnx|runsettings)$/i;

/**
 * A basename only a test suite produces: `FooTests.cs`, `Ledger_spec.fs`, `Tests.vb`. The
 * boundary before `test`/`spec` is what keeps `Latest.cs`, `Protest.cs` and `Bespec.cs` out of
 * the suite: a match needs the word to start the name, follow a separator, or open in caps.
 */
const TEST_FILE_NAME = /(?:^|[^A-Za-z])(?:test|spec)s?\.(?:cs|fs|vb)$/i;
const TEST_FILE_SUFFIX = /[A-Za-z0-9](?:Test|TEST|Spec|SPEC)(?:s|S)?\.(?:cs|fs|vb)$/;

/** `Tests`, `Specs` — a whole dotted part of a directory name. */
const TEST_SEGMENT_PART = /^(?:tests?|specs?)$/i;
/** `UnitTests`, `AcceptanceTests`, `E2ETests`, `AppTesting` — the word closing a camel-case part. */
const TEST_SEGMENT_SUFFIX = /[A-Za-z0-9](?:Test|TEST|Spec|SPEC)(?:s|S)?$/;
const TESTING_SEGMENT_SUFFIX = /[A-Za-z0-9](?:Testing|TESTING)$/;
const TESTING_PART = /^testing$/i;

/**
 * Whether one path segment names a test project. Any dotted part may carry the word, so
 * `App.Tests.Unit` counts as readily as `App.AcceptanceTests`; `Testing` counts only as a
 * qualifier on a project name (`App.Testing`), since a bare `Testing/` directory is as often a
 * production helper library as it is a suite.
 */
function isTestSegment(segment: string): boolean {
  const parts = segment.split(/[.\-_]+/).filter(Boolean);
  return parts.some(
    (part, index) =>
      TEST_SEGMENT_PART.test(part) ||
      TEST_SEGMENT_SUFFIX.test(part) ||
      TESTING_SEGMENT_SUFFIX.test(part) ||
      (index > 0 && TESTING_PART.test(part)),
  );
}

/**
 * Whether a repo-relative path belongs to the test suite. Scoping the weakening gate this way
 * keeps an unrelated `Skip =` or `[Test]` in production code from tripping it.
 */
export function isTestPath(file: string): boolean {
  const segments = file.split(/[\\/]/);
  const name = segments.pop() ?? "";
  if (TEST_FILE_NAME.test(name) || TEST_FILE_SUFFIX.test(name)) return true;
  // `App.Tests.csproj` names the project where no directory does, e.g. at the repository root.
  if (PROJECT_FILE.test(name) && isTestSegment(name.replace(PROJECT_FILE, ""))) return true;
  return segments.some(isTestSegment);
}

/** A test file the compiler reads, as opposed to fixtures, docs and data under the same tree. */
function isTestSource(file: string): boolean {
  return isTestPath(file) && COMPILED_SOURCE.test(file);
}

/** Whether the build reads this file at all: a source file it compiles, or a project it loads. */
function buildsInto(file: string): boolean {
  return COMPILED_SOURCE.test(file) || PROJECT_FILE.test(basename(file));
}

/** A file whose loss takes tests out of the run: a compiled test, or the project holding them. */
function isTestSuiteFile(file: string): boolean {
  return isTestPath(file) && buildsInto(file);
}

/** Whether any quoted value in the line names a path inside the test suite. */
function namesTestPath(line: string): boolean {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'/g)].some((m) => {
    const value = m[1] ?? m[2] ?? "";
    return value !== "" && isTestPath(value);
  });
}

/**
 * Constructs that make a test stop reporting its failure. Added to a test file, each one turns
 * a red suite green without touching the code under test, so the upgrade's evidence is void.
 */
export const TEST_WEAKENING_ADDED_PATTERNS: readonly LinePattern[] = [
  { token: "Skip =", pattern: /\bSkip\s*=(?![=>])/i },
  { token: "[Ignore]", pattern: /\[\s*Ignore\s*[\](,]/i },
  { token: "[Explicit]", pattern: /\[\s*Explicit\s*[\](,]/i },
  { token: "Assert.Inconclusive", pattern: /\bAssert\s*\.\s*Inconclusive\b/i },
  { token: "Assert.Pass", pattern: /\bAssert\s*\.\s*Pass\b/i },
];

/**
 * Attributes whose removal unregisters a test with the runner. Removed `Assert.*` calls are
 * deliberately absent: a legitimate refactor moves assertions constantly, and a gate that
 * fires on that gets switched off rather than obeyed.
 */
export const TEST_WEAKENING_REMOVED_PATTERNS: readonly LinePattern[] = [
  { token: "[Fact]", pattern: /\[\s*Fact\s*[\](,]/i },
  { token: "[Theory]", pattern: /\[\s*Theory\s*[\](,]/i },
  { token: "[TestMethod]", pattern: /\[\s*TestMethod\s*[\](,]/i },
  { token: "[TestCase", pattern: /\[\s*TestCase/i },
  { token: "[Test]", pattern: /\[\s*Test\s*[\](,]/i },
];

/**
 * Project and solution edits that take a whole suite out of `dotnet test` without touching a
 * single test method. One word in a `.csproj` is enough, so these are read wherever the build
 * reads them — a root `Directory.Build.props` is not itself a test path.
 */
function testPlumbingAdded(file: string): LinePattern[] {
  return [
    { token: "IsTestProject", pattern: /\bIsTestProject\s*[>=]\s*["']?\s*false\b/i },
    { token: "test case filter", pattern: /<\s*(?:VSTestTestCaseFilter|VSTestFilter|TestCaseFilter)\s*>/i },
    {
      token: "<Compile Remove>",
      pattern: /<\s*Compile\b[^>]*\bRemove\s*=/i,
      accept: (line) => isTestPath(file) || namesTestPath(line),
    },
  ];
}

/** The mirror: plumbing whose removal unregisters the suite. */
function testPlumbingRemoved(file: string): LinePattern[] {
  return [
    { token: "IsTestProject", pattern: /\bIsTestProject\s*[>=]\s*["']?\s*true\b/i },
    {
      token: "<ProjectReference>",
      pattern: /<\s*ProjectReference\b/i,
      accept: (line) => isTestPath(file) || namesTestPath(line),
    },
    { token: "solution test project", pattern: /^\s*Project\s*\(/i, accept: namesTestPath },
  ];
}

const GIT_ESCAPES: Record<string, string> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  '"': '"',
};

/**
 * Git quotes a path that carries a byte outside printable ASCII: the whole path is wrapped in
 * double quotes and each such byte is written as a `\nnn` octal escape. The bytes are UTF-8, so
 * they decode together rather than one escape at a time. A path left quoted matches nothing —
 * neither the manifest test nor a `testChanges` entry — so the gate silently lets it through.
 */
export function unquoteGitPath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const body = p.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const rest = body.slice(i + 1);
    if (rest === "") break;
    const octal = /^[0-7]{1,3}/.exec(rest)?.[0];
    if (octal) {
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    const escaped = rest[0] as string;
    bytes.push(...Buffer.from(GIT_ESCAPES[escaped] ?? escaped, "utf8"));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** `--- a/x`, `+++ "b/x"` -> `x`. `/dev/null` names no file: the side is an add or a delete. */
function diffPath(header: string): string | undefined {
  const raw = unquoteGitPath(header.slice(4).split("\t")[0]?.trim() ?? "");
  if (!raw || raw === "/dev/null") return undefined;
  return /^[ab]\//.test(raw) ? raw.slice(2) : raw;
}

/** `rename from x` carries the path on its own, with no `a/` prefix to strip. */
function renamePath(raw: string): string | undefined {
  const file = unquoteGitPath(raw.trim());
  return file === "" ? undefined : file;
}

/** One `diff --git` section: the paths it names, how it names them, and the lines it moves. */
type DiffSection = {
  /** The path on the base side, absent when the file is added. */
  source?: string;
  /** The path on the staged side, absent when the file is deleted. */
  target?: string;
  /** The `deleted file mode` line, when there is one. */
  deleted?: string;
  renamed: boolean;
  /** Added lines, in order, with the leading `+` stripped. */
  added: string[];
  /** Removed lines, in order, with the leading `-` stripped. */
  removed: string[];
  /** Runs of consecutive added lines, for a construct a reformat split over several of them. */
  addedRuns: string[][];
};

/**
 * Split a unified diff into its file sections. Reading both sides of a section, rather than one
 * line at a time, is what lets the scans tell a construct the change introduces from one the
 * base branch already carried and the change merely reindented.
 *
 * Path lines only carry a path in the `diff --git` preamble: past the first hunk a line opening
 * with `---` or `+++` is content, and even in the preamble a `+++` is a header only directly
 * after a `---`. A 100%-similarity rename has no hunk at all, so `rename from`/`rename to` are
 * the only lines naming its file.
 */
function parseDiffSections(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | undefined;
  let preamble = false;
  let header = false;
  let run: string[] = [];
  const endRun = (): void => {
    if (run.length > 1 && current) current.addedRuns.push(run);
    run = [];
  };
  for (const raw of diff.split(/\r?\n/)) {
    if (raw.startsWith("diff --git ")) {
      endRun();
      current = { renamed: false, added: [], removed: [], addedRuns: [] };
      sections.push(current);
      preamble = true;
      header = false;
      continue;
    }
    if (!current) continue;
    if (preamble) {
      if (raw.startsWith("deleted file mode")) {
        current.deleted = raw;
      } else if (raw.startsWith("rename from ")) {
        current.renamed = true;
        current.source = renamePath(raw.slice("rename from ".length));
      } else if (raw.startsWith("rename to ")) {
        current.renamed = true;
        current.target = renamePath(raw.slice("rename to ".length));
      } else if (raw.startsWith("--- ")) {
        current.source = diffPath(raw) ?? current.source;
        header = true;
        continue;
      } else if (header && raw.startsWith("+++ ")) {
        current.target = diffPath(raw) ?? current.target;
        preamble = false;
      } else if (raw.startsWith("@@")) {
        preamble = false;
      }
      header = false;
      continue;
    }
    if (raw.startsWith("@@")) {
      endRun();
      continue;
    }
    if (raw.startsWith("+")) {
      current.added.push(raw.slice(1));
      run.push(raw.slice(1));
      continue;
    }
    endRun();
    if (raw.startsWith("-")) current.removed.push(raw.slice(1));
  }
  endRun();
  return sections;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  const flat = collapse(text);
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * C# with string literals and comments blanked out. A test that asserts on the text `"Skip = 0"`
 * describes a construct rather than using one, and refusing the PR for it blocks a legitimate
 * upgrade; a construct that only appears inside a literal cannot disable anything.
 */
function codeView(line: string): string {
  return line
    .replace(/@?"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/, "");
}

type Hit = { index: number; line: string; token: string };

/**
 * The lines on one side of a section that the section really introduces. A construct the other
 * side already carried on an identical line was reindented, and one carried on a line that was
 * rewritten (a TFM bump on a single-line `PropertyGroup`, a file-scoped namespace conversion,
 * `[Theory]` and `[InlineData]` collapsed onto one line) was reformatted: neither is new. Only
 * the occurrences beyond what the other side carried are reported, so a genuine addition inside
 * a reformatted file still surfaces.
 *
 * A pattern that declares `args` is read a second way, because the line comparison cannot see a
 * suppression the change made worse without moving: whichever line it sits on, a code the other
 * side never carried is reported.
 */
function introduced(
  scan: readonly string[],
  opposite: readonly string[],
  patterns: readonly LinePattern[],
  view: (line: string) => string = (line) => line,
): Hit[] {
  const hits: Hit[] = [];
  for (const { token, pattern, accept, args } of patterns) {
    const matches = (line: string): boolean => {
      const text = view(line);
      return pattern.test(text) && (accept === undefined || accept(text));
    };
    const carried = opposite.filter(matches).map((line) => collapse(view(line)));
    const pool = new Map<string, number>();
    for (const line of carried) pool.set(line, (pool.get(line) ?? 0) + 1);
    const known = new Set<string>();
    if (args) {
      for (const line of opposite) {
        if (matches(line)) for (const code of args(view(line))) known.add(code);
      }
    }
    let reindented = 0;
    const candidates: Hit[] = [];
    const worsened: Hit[] = [];
    scan.forEach((line, index) => {
      if (!matches(line)) return;
      if (args && args(view(line)).some((code) => !known.has(code))) {
        worsened.push({ index, line, token });
      }
      const key = collapse(view(line));
      const seen = pool.get(key) ?? 0;
      if (seen > 0) {
        pool.set(key, seen - 1);
        reindented += 1;
        return;
      }
      candidates.push({ index, line, token });
    });
    hits.push(...candidates.slice(carried.length - reindented), ...worsened);
  }
  // One line names one construct: a sentence mentioning two of them is still one finding, and
  // the sort is stable, so the earliest pattern in the list is the one that names it.
  const reported = new Set<number>();
  const once: Hit[] = [];
  for (const hit of hits.sort((a, b) => a.index - b.index)) {
    if (reported.has(hit.index)) continue;
    reported.add(hit.index);
    once.push(hit);
  }
  return once;
}

/**
 * Constructs an added block spells across several lines. `[Fact(` / `Skip` / `= "flaky")]` is
 * one attribute however the writer wraps it, and no single line of it matches on its own.
 */
function introducedAcrossLines(section: DiffSection, patterns: readonly LinePattern[]): Hit[] {
  const hits: Hit[] = [];
  for (const { token, pattern, accept } of patterns) {
    const matches = (text: string): boolean => pattern.test(text) && (accept === undefined || accept(text));
    // A construct the removed side also carries was rewritten, not introduced.
    if (section.removed.some((line) => matches(codeView(line)))) continue;
    if (section.added.some((line) => matches(codeView(line)))) continue;
    for (const run of section.addedRuns) {
      const joined = run.map(codeView).join(" ");
      if (matches(joined)) hits.push({ index: 0, line: run.join(" "), token });
    }
  }
  return hits;
}

/**
 * Collapse to one finding per file and construct, then cap. A gate refuses on the first finding,
 * so a second `Skip =` in the same file adds nothing — and without the collapse, one file full
 * of noise fills the report and pushes the finding that matters out of it.
 */
function capReport<T extends { file: string; token: string }>(findings: T[], max: number): Report<T> {
  const seen = new Set<string>();
  const kept: T[] = [];
  for (const finding of findings) {
    const key = `${finding.file}\u0000${finding.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length >= max) return { findings: kept, truncated: true };
    kept.push(finding);
  }
  return { findings: kept, truncated: false };
}

/** Analyzer severities, weakest first: a setting that moves down this list stops failing a build. */
const SEVERITY_ORDER = ["none", "silent", "suggestion", "info", "warning", "error"];

const SEVERITY_SETTING = /^\s*(dotnet_(?:diagnostic|analyzer_diagnostic)\b[^=]*\.severity)\s*=\s*([A-Za-z]+)/i;

function severityKey(setting: string): string {
  return setting.toLowerCase().replace(/\s+/g, "");
}

/** Setting -> the strictest severity one side of a section assigns it. */
function severityLevels(lines: readonly string[]): Map<string, number> {
  const levels = new Map<string, number>();
  for (const line of lines) {
    const match = SEVERITY_SETTING.exec(line);
    if (!match) continue;
    const rank = SEVERITY_ORDER.indexOf((match[2] ?? "").toLowerCase());
    if (rank < 0) continue;
    const key = severityKey(match[1] ?? "");
    levels.set(key, Math.max(levels.get(key) ?? -1, rank));
  }
  return levels;
}

/**
 * Diagnostics the section moves to a weaker severity. `error` -> `warning` is the argument-level
 * blind spot in `.editorconfig` form: both sides carry the setting, so the line comparison reads
 * the rewrite as a reformat, and the added value is still strict enough that no suppression
 * pattern matches it. A diagnostic that stops failing the build has been silenced by degrees.
 */
function severityDowngrades(section: DiffSection): Hit[] {
  const before = severityLevels(section.removed);
  const after = severityLevels(section.added);
  const hits: Hit[] = [];
  section.added.forEach((line, index) => {
    const match = SEVERITY_SETTING.exec(line);
    if (!match) return;
    const key = severityKey(match[1] ?? "");
    const was = before.get(key);
    const now = after.get(key);
    if (was === undefined || now === undefined || now >= was) return;
    hits.push({ index, line, token: "diagnostic severity" });
  });
  return hits;
}

/**
 * Suppressions introduced by a unified diff (`git diff --cached -U0`). A suppression the base
 * branch already carried is not this change's doing, so a construct is only reported where the
 * section adds one the other side did not have — or removes a setting whose absence is itself
 * the suppression. `ignoreFile` keeps build output out of the report; callers pass their
 * artifact test.
 */
export function findSuppressions(
  diff: string,
  ignoreFile: (file: string) => boolean = () => false,
): SuppressionReport {
  const found: Suppression[] = [];
  for (const section of parseDiffSections(diff)) {
    const file = section.target ?? section.source;
    if (file === undefined || ignoreFile(file)) continue;
    for (const hit of introduced(section.added, section.removed, SUPPRESSION_PATTERNS)) {
      found.push({ file, line: clip(hit.line, MAX_SUPPRESSION_CHARS), token: hit.token });
    }
    for (const hit of severityDowngrades(section)) {
      found.push({ file, line: clip(hit.line, MAX_SUPPRESSION_CHARS), token: hit.token });
    }
    for (const hit of introduced(section.removed, section.added, STRICTNESS_REMOVAL_PATTERNS)) {
      found.push({
        file,
        line: clip(`removed: ${hit.line}`, MAX_SUPPRESSION_CHARS),
        token: hit.token,
      });
    }
  }
  return capReport(found, MAX_SUPPRESSIONS);
}

/**
 * Tests disabled, unregistered, deleted, renamed out of the build, or unplugged from the project
 * by a unified diff (`git diff --cached -U0`). Unlike a suppression, removal is the whole point
 * of the check, so both sides of the diff are read: an added `Skip =`, a removed `[Fact]`, a
 * `git mv` of the file out of the test tree and an `<IsTestProject>false</IsTestProject>` all
 * silence a test equally well. `ignoreFile` keeps build output out of the report; callers pass
 * their artifact test.
 */
export function findTestWeakening(
  diff: string,
  ignoreFile: (file: string) => boolean = () => false,
): TestWeakeningReport {
  const found: TestWeakening[] = [];
  const report = (file: string, content: string, token: string): void => {
    found.push({ file, line: clip(content, MAX_TEST_WEAKENING_CHARS), token });
  };
  /** The path a finding is reported under, or undefined when this side is out of the gate. */
  const gated = (file: string | undefined): string | undefined =>
    file !== undefined && isTestPath(file) && !ignoreFile(file) ? file : undefined;

  for (const section of parseDiffSections(diff)) {
    const { source, target } = section;
    const file = target ?? source;
    if (file === undefined) continue;

    // Losing the file loses every test in it, and the body that follows is one finding, not many.
    const base = gated(source);
    if (base !== undefined && isTestSuiteFile(base)) {
      if (section.deleted !== undefined) {
        report(base, section.deleted, "deleted test file");
        continue;
      }
      if (section.renamed && target !== undefined && target !== base) {
        const token = !isTestPath(target) || ignoreFile(target)
          ? "test file moved out of the test suite"
          : !buildsInto(target)
            ? "test file renamed to an extension the build ignores"
            : undefined;
        if (token !== undefined) {
          report(base, `${base} -> ${target}`, token);
          continue;
        }
      }
    }

    const added = gated(target);
    if (added !== undefined && isTestSource(added)) {
      for (const hit of introduced(section.added, section.removed, TEST_WEAKENING_ADDED_PATTERNS, codeView)) {
        report(added, hit.line, hit.token);
      }
      for (const hit of introducedAcrossLines(section, TEST_WEAKENING_ADDED_PATTERNS)) {
        report(added, hit.line, hit.token);
      }
    }
    if (base !== undefined && isTestSource(base)) {
      for (const hit of introduced(section.removed, section.added, TEST_WEAKENING_REMOVED_PATTERNS, codeView)) {
        report(base, hit.line, hit.token);
      }
    }

    if (BUILD_FILE.test(file) && !ignoreFile(file)) {
      for (const hit of introduced(section.added, section.removed, testPlumbingAdded(file))) {
        report(file, hit.line, hit.token);
      }
      for (const hit of introduced(section.removed, section.added, testPlumbingRemoved(file))) {
        report(file, `removed: ${hit.line}`, hit.token);
      }
    }
  }
  return capReport(found, MAX_TEST_WEAKENINGS);
}

/** Compare the two sides of one changed manifest. Either side may be "" for add/delete. */
export function diffManifests(before: string, after: string, file: string): DependencyChanges {
  const changes = emptyDependencyChanges();
  if (before.length > MAX_MANIFEST_BYTES || after.length > MAX_MANIFEST_BYTES) {
    changes.skipped.push(file);
    return changes;
  }
  const name = basename(file).toLowerCase();
  if (name === "global.json") {
    const from = parseSdkPin(before);
    const to = parseSdkPin(after);
    const kind = classify(from, to);
    if (kind) changes.sdks.push({ file, ...versionFields(from, to), kind });
    return changes;
  }
  if (isDockerfile(name)) {
    changes.images.push(...diffImages(before, after, file));
    return changes;
  }
  if (name === "packages.lock.json") return changes;
  changes.packages.push(...diffPackages(before, after, file));
  changes.frameworks.push(...diffFrameworks(before, after, file));
  return changes;
}
