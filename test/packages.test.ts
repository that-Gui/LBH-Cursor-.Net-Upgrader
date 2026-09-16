import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  capDependencyChanges,
  diffManifests,
  emptyDependencyChanges,
  findSuppressions,
  findTestWeakening,
  isPackageManifest,
  isTestPath,
  MAX_MANIFEST_BYTES,
  MAX_SUPPRESSIONS,
  MAX_TEST_WEAKENING_CHARS,
  MAX_TEST_WEAKENINGS,
  parseDockerImages,
  parsePackageVersions,
  parseSdkPin,
  parseTargetFrameworks,
  unquoteGitPath,
  type Suppression,
  type TestWeakening,
} from "../src/packages";

function csproj(body: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n`;
}

/** The findings, for the cases that are not about the cap. */
function suppressions(diff: string, ignoreFile?: (file: string) => boolean): Suppression[] {
  return findSuppressions(diff, ignoreFile).findings;
}

function weakenings(diff: string, ignoreFile?: (file: string) => boolean): TestWeakening[] {
  return findTestWeakening(diff, ignoreFile).findings;
}

/** `file (token)` pairs, the form the refusal message names them in. */
function summarise(found: { file: string; token: string }[]): string[] {
  return found.map((f) => `${f.file} (${f.token})`);
}

describe("isPackageManifest", () => {
  it("accepts project files, any MSBuild import, global.json, lock files, and Dockerfiles", () => {
    for (const p of [
      "App.csproj",
      "src/Lib.fsproj",
      "src/Old.vbproj",
      "Directory.Packages.props",
      "src/Directory.Build.props",
      // A repository's own import carries a PackageReference exactly as the known names do.
      "build/Dependencies.props",
      "eng/Versions.props",
      "build/Packaging.targets",
      "src/App.Api/packages.config",
      "global.json",
      "src/packages.lock.json",
      "Dockerfile",
      "docker/Dockerfile.ci",
      "build/api.dockerfile",
    ]) {
      assert.equal(isPackageManifest(p), true, `expected ${p} to be a manifest`);
    }
  });

  it("rejects source, config, and lookalike paths", () => {
    for (const p of ["src/Program.cs", "appsettings.json", "README.md", "docs/global.json.md", "Makefile"]) {
      assert.equal(isPackageManifest(p), false, `expected ${p} not to be a manifest`);
    }
  });
});

describe("parsePackageVersions", () => {
  it("reads Version as an attribute and as a child element", () => {
    const xml = csproj(`
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.3" />
    <PackageReference Include="Serilog">
      <Version>2.12.0</Version>
    </PackageReference>
  </ItemGroup>`);
    assert.deepEqual(
      [...parsePackageVersions(xml)],
      [
        ["Newtonsoft.Json", "12.0.3"],
        ["Serilog", "2.12.0"],
      ],
    );
  });

  it("reads Update= and PackageVersion for central package management", () => {
    const props = `<Project>
  <ItemGroup>
    <PackageVersion Include="Microsoft.EntityFrameworkCore" Version="8.0.4" />
    <PackageReference Update="Microsoft.SourceLink.GitHub" Version="8.0.0" />
  </ItemGroup>
</Project>`;
    assert.deepEqual(
      [...parsePackageVersions(props)],
      [
        ["Microsoft.EntityFrameworkCore", "8.0.4"],
        ["Microsoft.SourceLink.GitHub", "8.0.0"],
      ],
    );
  });

  it("records a CPM-managed reference with no version as an empty string, not as absent", () => {
    const versions = parsePackageVersions(csproj(`<ItemGroup><PackageReference Include="Serilog" /></ItemGroup>`));
    assert.equal(versions.get("Serilog"), "");
    assert.equal(versions.has("Serilog"), true);
  });

  it("ignores commented-out references and decodes entities", () => {
    const xml = csproj(`
  <ItemGroup>
    <!-- <PackageReference Include="Ghost" Version="1.0.0" /> -->
    <PackageReference Include="A&amp;B.Client" Version="1.0.0" />
  </ItemGroup>`);
    assert.equal(parsePackageVersions(xml).has("Ghost"), false);
    assert.equal(parsePackageVersions(xml).get("A&B.Client"), "1.0.0");
  });

  it("reads a legacy packages.config, in either element form and whatever order the attributes come in", () => {
    const config = [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<packages>",
      '  <package id="Serilog" version="2.12.0" targetFramework="net48" />',
      '  <package targetFramework="net48" version="13.0.3" id="Newtonsoft.Json" />',
      // `allowedVersions` is a constraint, not the resolved version: reading it as one would
      // report a range as a version and read every re-pin of the range as a version move.
      '  <package id="Unversioned.Pkg" allowedVersions="[1.0,2.0)" developmentDependency="true" />',
      '  <package id="Paired.Pkg" version="1.2.3"></package>',
      "</packages>",
      "",
    ].join("\n");
    assert.deepEqual(
      [...parsePackageVersions(config)],
      [
        ["Serilog", "2.12.0"],
        ["Newtonsoft.Json", "13.0.3"],
        ["Unversioned.Pkg", ""],
        ["Paired.Pkg", "1.2.3"],
      ],
    );
  });

  it("does not read the packages.config root element as a package of its own", () => {
    assert.deepEqual([...parsePackageVersions("<packages>\n</packages>\n")], []);
    assert.equal(parsePackageVersions('<packages><package id="A" version="1.0.0" /></packages>').size, 1);
  });
});

describe("parseTargetFrameworks", () => {
  it("reads a single TFM and a multi-targeted list", () => {
    assert.deepEqual(
      parseTargetFrameworks(csproj("<PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>")),
      ["net8.0"],
    );
    assert.deepEqual(
      parseTargetFrameworks(
        csproj("<PropertyGroup><TargetFrameworks>net8.0;netstandard2.0</TargetFrameworks></PropertyGroup>"),
      ),
      ["net8.0", "netstandard2.0"],
    );
  });

  it("returns nothing for a project without a TFM", () => {
    assert.deepEqual(parseTargetFrameworks(csproj("<PropertyGroup />")), []);
  });
});

describe("parseSdkPin", () => {
  it("reads sdk.version and tolerates other content", () => {
    assert.equal(parseSdkPin('{"sdk":{"version":"8.0.100","rollForward":"latestFeature"}}'), "8.0.100");
    assert.equal(parseSdkPin('{"msbuild-sdks":{"X":"1.0"}}'), undefined);
    assert.equal(parseSdkPin("not json"), undefined);
    assert.equal(parseSdkPin(""), undefined);
  });
});

describe("parseDockerImages", () => {
  it("reads tags, platform flags, and digests, and skips stage references", () => {
    const dockerfile = [
      "FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:8.0 AS build",
      "RUN dotnet publish",
      "FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine AS runtime",
      "FROM build AS test",
      "FROM ghcr.io/org/tool@sha256:abc123",
    ].join("\n");
    assert.deepEqual(
      [...parseDockerImages(dockerfile)],
      [
        ["mcr.microsoft.com/dotnet/sdk", "8.0"],
        ["mcr.microsoft.com/dotnet/aspnet", "8.0-alpine"],
        ["ghcr.io/org/tool", "sha256:abc123"],
      ],
    );
  });

  it("collapses repeated pulls of one image and defaults an untagged image to latest", () => {
    const dockerfile = "FROM alpine\nFROM mcr.microsoft.com/dotnet/sdk:8.0 AS a\nFROM mcr.microsoft.com/dotnet/sdk:9.0 AS b\n";
    assert.deepEqual(
      [...parseDockerImages(dockerfile)],
      [
        ["alpine", "latest"],
        ["mcr.microsoft.com/dotnet/sdk", "8.0, 9.0"],
      ],
    );
  });
});

describe("diffManifests", () => {
  const before = csproj(`
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="12.0.3" />
    <PackageReference Include="Dropped.Package" Version="1.0.0" />
  </ItemGroup>`);
  const after = csproj(`
  <PropertyGroup><TargetFramework>net10.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.3" />
    <PackageReference Include="Added.Package" Version="2.0.0" />
  </ItemGroup>`);

  it("classifies changed, removed, and added references and the TFM move", () => {
    const changes = diffManifests(before, after, "src/App.csproj");
    assert.deepEqual(changes.packages, [
      { file: "src/App.csproj", package: "Newtonsoft.Json", from: "12.0.3", to: "13.0.3", kind: "changed" },
      { file: "src/App.csproj", package: "Dropped.Package", from: "1.0.0", kind: "removed" },
      { file: "src/App.csproj", package: "Added.Package", to: "2.0.0", kind: "added" },
    ]);
    assert.deepEqual(changes.frameworks, [
      { file: "src/App.csproj", from: "net8.0", to: "net10.0", kind: "changed" },
    ]);
    assert.deepEqual(changes.sdks, []);
    assert.deepEqual(changes.images, []);
  });

  it("reports nothing when the manifest is unchanged", () => {
    const changes = diffManifests(before, before, "src/App.csproj");
    assert.deepEqual(changes, emptyDependencyChanges());
  });

  it("matches package ids case-insensitively and keeps the new spelling", () => {
    const renamed = diffManifests(
      csproj('<ItemGroup><PackageReference Include="newtonsoft.json" Version="12.0.3" /></ItemGroup>'),
      csproj('<ItemGroup><PackageReference Include="Newtonsoft.Json" Version="13.0.3" /></ItemGroup>'),
      "App.csproj",
    );
    assert.deepEqual(renamed.packages, [
      { file: "App.csproj", package: "Newtonsoft.Json", from: "12.0.3", to: "13.0.3", kind: "changed" },
    ]);
  });

  it("treats a version moving into central package management as changed, not removed", () => {
    const moved = diffManifests(
      csproj('<ItemGroup><PackageReference Include="Serilog" Version="2.12.0" /></ItemGroup>'),
      csproj('<ItemGroup><PackageReference Include="Serilog" /></ItemGroup>'),
      "App.csproj",
    );
    assert.deepEqual(moved.packages, [
      { file: "App.csproj", package: "Serilog", from: "2.12.0", to: "", kind: "changed" },
    ]);
  });

  it("diffs the global.json SDK pin", () => {
    const changes = diffManifests('{"sdk":{"version":"8.0.100"}}', '{"sdk":{"version":"10.0.100"}}', "global.json");
    assert.deepEqual(changes.sdks, [{ file: "global.json", from: "8.0.100", to: "10.0.100", kind: "changed" }]);
    assert.deepEqual(changes.packages, []);
  });

  it("diffs Dockerfile base image tags", () => {
    const changes = diffManifests(
      "FROM mcr.microsoft.com/dotnet/aspnet:8.0\n",
      "FROM mcr.microsoft.com/dotnet/aspnet:10.0\n",
      "Dockerfile",
    );
    assert.deepEqual(changes.images, [
      {
        file: "Dockerfile",
        image: "mcr.microsoft.com/dotnet/aspnet",
        from: "8.0",
        to: "10.0",
        kind: "changed",
      },
    ]);
  });

  it("records an added manifest as additions rather than throwing", () => {
    const changes = diffManifests("", '{"sdk":{"version":"10.0.100"}}', "global.json");
    assert.deepEqual(changes.sdks, [{ file: "global.json", to: "10.0.100", kind: "added" }]);
  });

  const packagesConfig = (entries: string[]): string =>
    ['<?xml version="1.0" encoding="utf-8"?>', "<packages>", ...entries, "</packages>", ""].join("\n");

  const CONFIG_FILE = "src/App.Api/packages.config";

  it("classifies an addition, a bump and a drop in a legacy packages.config", () => {
    const changes = diffManifests(
      packagesConfig([
        '  <package id="Serilog" version="2.12.0" targetFramework="net48" />',
        '  <package id="Dropped.Pkg" version="1.0.0" targetFramework="net48" />',
      ]),
      packagesConfig([
        '  <package id="Serilog" version="4.0.0" targetFramework="net48" />',
        '  <package id="Smuggled.Pkg" version="9.9.9" targetFramework="net48" />',
      ]),
      CONFIG_FILE,
    );
    assert.deepEqual(changes.packages, [
      { file: CONFIG_FILE, package: "Serilog", from: "2.12.0", to: "4.0.0", kind: "changed" },
      { file: CONFIG_FILE, package: "Dropped.Pkg", from: "1.0.0", kind: "removed" },
      { file: CONFIG_FILE, package: "Smuggled.Pkg", to: "9.9.9", kind: "added" },
    ]);
    // `targetFramework` is an attribute of a reference, not the project's TFM.
    assert.deepEqual(changes.frameworks, []);
  });

  it("reads a packages.config deleted for a PackageReference migration as removals, not additions", () => {
    // The evidence gate asks the writer to justify `added` rows only, so a legitimate migration
    // off packages.config must not arrive as a pile of unexplained new packages.
    const changes = diffManifests(
      packagesConfig([
        '  <package id="Serilog" version="2.12.0" targetFramework="net48" />',
        '  <package id="Newtonsoft.Json" version="12.0.3" targetFramework="net48" />',
      ]),
      "",
      CONFIG_FILE,
    );
    assert.deepEqual(
      changes.packages.map((p) => [p.package, p.kind, p.to]),
      [
        ["Serilog", "removed", undefined],
        ["Newtonsoft.Json", "removed", undefined],
      ],
    );
  });

  it("skips a blob over the size cap instead of parsing it", () => {
    const huge = `${" ".repeat(MAX_MANIFEST_BYTES)}x`;
    const changes = diffManifests(huge, huge, "src/packages.lock.json");
    assert.deepEqual(changes.skipped, ["src/packages.lock.json"]);
    assert.deepEqual(changes.packages, []);
  });
});

describe("capDependencyChanges", () => {
  it("keeps the first rows and counts the rest as omitted", () => {
    const packages = Array.from({ length: 5 }, (_, i) => ({
      file: "App.csproj",
      package: `P${i}`,
      from: "1.0.0",
      to: "2.0.0",
      kind: "changed" as const,
    }));
    const capped = capDependencyChanges({ ...emptyDependencyChanges(), packages }, 3);
    assert.equal(capped.packages.length, 3);
    assert.equal(capped.packages[0]?.package, "P0");
    assert.equal(capped.omitted, 2);
  });

  it("leaves a change set under the cap untouched", () => {
    const changes = emptyDependencyChanges();
    assert.equal(capDependencyChanges(changes), changes);
  });
});

function hunk(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "index 1111111..2222222 100644",
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,0 +1,1 @@",
    ...lines,
    "",
  ].join("\n");
}

const gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "packages-diff-"));
let scratchCount = 0;

after(() => {
  fs.rmSync(gitRoot, { recursive: true, force: true });
});

function rawGit(args: string[], cwd: string): string {
  const res = spawnSync(
    "git",
    ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "core.autocrlf=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`raw git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function writeFiles(repo: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repo, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

/**
 * A real `git diff --cached` over a scratch repository. Hand-written fixtures are why renames
 * went unhandled: a 100%-similarity rename carries nothing but `rename from`/`rename to`, and
 * nobody writing a fixture by hand produces that shape.
 */
function realDiff(
  base: Record<string, string>,
  mutate: (repo: string, git: (args: string[]) => string) => void,
  options: { context?: boolean } = {},
): string {
  const repo = path.join(gitRoot, `repo-${(scratchCount += 1)}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (args: string[]): string => rawGit(args, repo);
  git(["init", "-q", "-b", "main"]);
  writeFiles(repo, base);
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  mutate(repo, git);
  git(["add", "-A"]);
  return git(["diff", "--cached", ...(options.context === true ? [] : ["-U0"])]);
}

const CALCULATOR_TESTS = [
  "using Xunit;",
  "",
  "namespace App.Tests;",
  "",
  "public class CalculatorTests",
  "{",
  "    [Fact]",
  "    public void Adds()",
  "    {",
  "        Assert.Equal(2, Calculator.Add(1, 1));",
  "    }",
  "",
  "    [Theory]",
  "    [InlineData(1)]",
  "    public void AddsMany(int n)",
  "    {",
  "        Assert.Equal(n, Calculator.Add(n, 0));",
  "    }",
  "}",
  "",
].join("\n");

const TEST_CSPROJ = [
  '<Project Sdk="Microsoft.NET.Sdk">',
  "  <PropertyGroup>",
  "    <TargetFramework>net6.0</TargetFramework>",
  "    <IsTestProject>true</IsTestProject>",
  "  </PropertyGroup>",
  "  <ItemGroup>",
  '    <PackageReference Include="xunit" Version="2.4.2" />',
  "  </ItemGroup>",
  "  <ItemGroup>",
  '    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />',
  "  </ItemGroup>",
  "</Project>",
  "",
].join("\n");

const SOLUTION = [
  "Microsoft Visual Studio Solution File, Format Version 12.00",
  'Project("{FAE04EC0}") = "App", "src\\App\\App.csproj", "{AAA}"',
  "EndProject",
  'Project("{FAE04EC0}") = "App.Tests", "test\\App.Tests\\App.Tests.csproj", "{BBB}"',
  "EndProject",
  "",
].join("\n");

const BUILD_PROPS = [
  "<Project>",
  "  <PropertyGroup>",
  "    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
  "    <NoWarn>CS1591</NoWarn>",
  "    <NuGetAudit>true</NuGetAudit>",
  "  </PropertyGroup>",
  "</Project>",
  "",
].join("\n");

/** The whole suite: tests, the project that runs them, the solution that lists it. */
const TEST_REPO: Record<string, string> = {
  "App.sln": SOLUTION,
  "Directory.Build.props": BUILD_PROPS,
  "test/App.Tests/App.Tests.csproj": TEST_CSPROJ,
  "test/App.Tests/CalculatorTests.cs": CALCULATOR_TESTS,
  "src/App/App.csproj": '<Project Sdk="Microsoft.NET.Sdk" />\n',
  "src/App/Program.cs": "public static class Program { public static void Main() { } }\n",
};

function edit(repo: string, file: string, replace: string, by: string): void {
  const target = path.join(repo, file);
  const before = fs.readFileSync(target, "utf8");
  assert.ok(before.includes(replace), `fixture ${file} does not contain ${JSON.stringify(replace)}`);
  fs.writeFileSync(target, before.replace(replace, by));
}

describe("findSuppressions", () => {
  it("reports an added pragma with its file, construct, and collapsed text", () => {
    const found = suppressions(hunk("src/Program.cs", ["+    #pragma warning disable   CS0618"]));
    assert.deepEqual(found, [
      { file: "src/Program.cs", line: "#pragma warning disable CS0618", token: "#pragma warning disable" },
    ]);
  });

  it("reports each MSBuild construct that silences a diagnostic", () => {
    const cases: [string, string][] = [
      ["  <NoWarn>$(NoWarn);CS1591</NoWarn>", "NoWarn"],
      ["  <WarningsNotAsErrors>CS8600</WarningsNotAsErrors>", "WarningsNotAsErrors"],
      ["  <TreatWarningsAsErrors>false</TreatWarningsAsErrors>", "TreatWarningsAsErrors"],
      ["  <NuGetAuditMode>direct</NuGetAuditMode>", "NuGetAuditMode"],
      ["  <NuGetAuditLevel>critical</NuGetAuditLevel>", "NuGetAuditLevel"],
      ["  <NuGetAudit>false</NuGetAudit>", "NuGetAudit"],
      ["  <WarningLevel>0</WarningLevel>", "WarningLevel"],
      ["  <EnableNETAnalyzers>false</EnableNETAnalyzers>", "EnableNETAnalyzers"],
      ["  <AnalysisLevel>none</AnalysisLevel>", "AnalysisLevel"],
      ["  <Nullable>disable</Nullable>", "Nullable"],
      ["  <RunAnalyzersDuringBuild>false</RunAnalyzersDuringBuild>", "RunAnalyzers"],
    ];
    for (const [line, token] of cases) {
      const found = suppressions(hunk("Directory.Build.props", [`+${line}`]));
      assert.equal(found.length, 1, `expected ${line} to be reported`);
      assert.equal(found[0]?.token, token);
      assert.equal(found[0]?.file, "Directory.Build.props");
    }
  });

  it("reports the two suppressions modern .NET reaches for first", () => {
    const attribute = suppressions(
      hunk("src/Program.cs", [
        '+[System.Diagnostics.CodeAnalysis.SuppressMessage("Usage", "CA2200:Rethrow", Justification = "net10 noise")]',
      ]),
    );
    assert.deepEqual(summarise(attribute), ["src/Program.cs (SuppressMessage)"]);

    const severity = suppressions(
      hunk(".editorconfig", [
        "+dotnet_diagnostic.CA1822.severity = none",
        "+dotnet_analyzer_diagnostic.severity = silent",
      ]),
    );
    assert.deepEqual(summarise(severity), [".editorconfig (diagnostic severity)"]);
  });

  it("reads a severity downgrade as a suppression, whichever side of it the diff shows", () => {
    const found = suppressions(
      hunk(".editorconfig", [
        "-dotnet_diagnostic.CA1822.severity = warning",
        "+dotnet_diagnostic.CA1822.severity = none",
      ]),
    );
    assert.deepEqual(summarise(found), [".editorconfig (diagnostic severity)"]);
  });

  it("reports a strictness setting the diff removes, since removing it is setting it false", () => {
    const found = suppressions(
      hunk("Directory.Build.props", [
        "-  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>",
        "-  <NuGetAudit>true</NuGetAudit>",
      ]),
    );
    assert.deepEqual(summarise(found), [
      "Directory.Build.props (TreatWarningsAsErrors)",
      "Directory.Build.props (NuGetAudit)",
    ]);
    assert.equal(found[0]?.line, "removed: <TreatWarningsAsErrors>true</TreatWarningsAsErrors>");
  });

  it("leaves alone what the diff does not introduce: context lines and warnings-as-errors turned on", () => {
    const context = suppressions(hunk("App.csproj", ["   <NoWarn>CS1591</NoWarn>", "   <PropertyGroup>"]));
    assert.deepEqual(context, []);
    const stricter = suppressions(hunk("App.csproj", ["+  <TreatWarningsAsErrors>true</TreatWarningsAsErrors>"]));
    assert.deepEqual(stricter, []);
  });

  it("leaves a token the file already carried alone when the line around it is rewritten", () => {
    // The TFM and the NoWarn share a line, so retargeting re-adds a suppression the base branch
    // already had. Reporting it makes such a repository impossible to upgrade at all.
    const retarget = suppressions(
      hunk("App.csproj", [
        "-  <PropertyGroup><TargetFramework>net6.0</TargetFramework><NoWarn>CS1591</NoWarn></PropertyGroup>",
        "+  <PropertyGroup><TargetFramework>net10.0</TargetFramework><NoWarn>CS1591</NoWarn></PropertyGroup>",
      ]),
    );
    assert.deepEqual(retarget, []);

    const shrunk = suppressions(
      hunk("Directory.Build.props", ["-  <NoWarn>CS1591</NoWarn>", "+  <NoWarn></NoWarn>"]),
    );
    assert.deepEqual(shrunk, [], "a shorter NoWarn list is stricter, not a new suppression");
  });

  it("leaves a reindented props file alone but still reports what the reindent brought with it", () => {
    const reindent = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "Directory.Build.props");
      const text = fs.readFileSync(file, "utf8").replace(/^ {4}/gm, "        ");
      fs.writeFileSync(file, text);
    });
    assert.deepEqual(suppressions(reindent), []);

    const reindentAndSuppress = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "Directory.Build.props");
      const text = fs
        .readFileSync(file, "utf8")
        .replace(/^ {4}/gm, "        ")
        .replace("  </PropertyGroup>", "        <NoWarn>$(NoWarn);CS8618</NoWarn>\n  </PropertyGroup>");
      fs.writeFileSync(file, text);
    });
    assert.deepEqual(summarise(suppressions(reindentAndSuppress)), ["Directory.Build.props (NoWarn)"]);
    assert.equal(suppressions(reindentAndSuppress)[0]?.line, "<NoWarn>$(NoWarn);CS8618</NoWarn>");
  });

  it("reports a code appended to a NoWarn the file already carried", () => {
    // Adding to a list that is already there is the quietest way to silence a warning, and the
    // line it sits on is a rewrite of a line that always carried the token, so comparing lines
    // reads it as a reformat. The codes are what changed.
    const appended = realDiff(TEST_REPO, (repo) => {
      edit(repo, "Directory.Build.props", "<NoWarn>CS1591</NoWarn>", "<NoWarn>CS1591;CS0618</NoWarn>");
    });
    assert.deepEqual(summarise(suppressions(appended)), ["Directory.Build.props (NoWarn)"]);
    assert.equal(suppressions(appended)[0]?.line, "<NoWarn>CS1591;CS0618</NoWarn>");

    // The same append hidden inside a reindent of the whole file.
    const appendedWhileReindenting = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "Directory.Build.props");
      const text = fs
        .readFileSync(file, "utf8")
        .replace("<NoWarn>CS1591</NoWarn>", "<NoWarn>CS1591;CS0618</NoWarn>")
        .replace(/^ {4}/gm, "        ");
      fs.writeFileSync(file, text);
    });
    assert.deepEqual(summarise(suppressions(appendedWhileReindenting)), ["Directory.Build.props (NoWarn)"]);
  });

  it("reports a code appended to a WarningsNotAsErrors the file already carried", () => {
    const base = {
      ...TEST_REPO,
      "Directory.Build.props": BUILD_PROPS.replace(
        "<NoWarn>CS1591</NoWarn>",
        "<WarningsNotAsErrors>CS1591</WarningsNotAsErrors>",
      ),
    };
    const appended = realDiff(base, (repo) => {
      edit(
        repo,
        "Directory.Build.props",
        "<WarningsNotAsErrors>CS1591</WarningsNotAsErrors>",
        "<WarningsNotAsErrors>CS1591;SYSLIB0011</WarningsNotAsErrors>",
      );
    });
    assert.deepEqual(summarise(suppressions(appended)), ["Directory.Build.props (WarningsNotAsErrors)"]);
  });

  it("reports a code appended on the one line that also carries the TFM", () => {
    const oneLine: Record<string, string> = {
      "src/App/App.csproj": [
        '<Project Sdk="Microsoft.NET.Sdk">',
        "  <PropertyGroup><TargetFramework>net6.0</TargetFramework><NoWarn>CS1591</NoWarn></PropertyGroup>",
        "</Project>",
        "",
      ].join("\n"),
    };
    const retargetOnly = realDiff(oneLine, (repo) => {
      edit(repo, "src/App/App.csproj", "net6.0", "net10.0");
    });
    assert.deepEqual(suppressions(retargetOnly), [], "the TFM moved; the NoWarn did not");

    const retargetAndAppend = realDiff(oneLine, (repo) => {
      edit(repo, "src/App/App.csproj", "net6.0", "net10.0");
      edit(repo, "src/App/App.csproj", "<NoWarn>CS1591</NoWarn>", "<NoWarn>CS1591;CS0618</NoWarn>");
    });
    assert.deepEqual(summarise(suppressions(retargetAndAppend)), ["src/App/App.csproj (NoWarn)"]);
  });

  it("leaves a NoWarn alone wherever the codes did not get worse", () => {
    const twoCodes = {
      ...TEST_REPO,
      "Directory.Build.props": BUILD_PROPS.replace("<NoWarn>CS1591</NoWarn>", "<NoWarn>CS1591;CS0618</NoWarn>"),
    };

    const reindented = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "Directory.Build.props");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/^ {4}/gm, "        "));
    });
    assert.deepEqual(suppressions(reindented), [], "a reindent silences nothing new");

    const shrunk = realDiff(TEST_REPO, (repo) => {
      edit(repo, "Directory.Build.props", "<NoWarn>CS1591</NoWarn>", "<NoWarn></NoWarn>");
    });
    assert.deepEqual(suppressions(shrunk), [], "an emptied NoWarn list is stricter, not a new suppression");

    const reordered = realDiff(twoCodes, (repo) => {
      edit(repo, "Directory.Build.props", "<NoWarn>CS1591;CS0618</NoWarn>", "<NoWarn>CS0618;CS1591</NoWarn>");
    });
    assert.deepEqual(suppressions(reordered), [], "reordering a NoWarn list is a no-op");

    const dropped = realDiff(twoCodes, (repo) => {
      edit(repo, "Directory.Build.props", "<NoWarn>CS1591;CS0618</NoWarn>", "<NoWarn>CS0618</NoWarn>");
    });
    assert.deepEqual(suppressions(dropped), [], "removing a code is strictly stronger");

    // `$(NoWarn)` inherits the value the imports already set; it silences nothing on its own.
    const inherited = realDiff(TEST_REPO, (repo) => {
      edit(repo, "Directory.Build.props", "<NoWarn>CS1591</NoWarn>", "<NoWarn>$(NoWarn);CS1591</NoWarn>");
    });
    assert.deepEqual(suppressions(inherited), []);
  });

  it("reports a code appended to a pragma but not a reworded justification", () => {
    const appended = suppressions(
      hunk("src/Program.cs", [
        "-#pragma warning disable CS1591",
        "+#pragma warning disable CS1591, CS0618",
      ]),
    );
    assert.deepEqual(summarise(appended), ["src/Program.cs (#pragma warning disable)"]);

    const reworded = suppressions(
      hunk("src/Program.cs", [
        "-#pragma warning disable CS1591 // legacy XML docs",
        "+#pragma warning disable CS1591 // legacy XML docs, tracked in ADR 12",
      ]),
    );
    assert.deepEqual(reworded, [], "the codes are the suppression; the comment beside them is not");
  });

  it("reports a [SuppressMessage] that gains a rule id but not one that gains a justification", () => {
    const gained = suppressions(
      hunk("src/Program.cs", [
        '-[SuppressMessage("Usage", "CA2200:Rethrow to preserve stack details")]',
        '+[SuppressMessage("Usage", "CA2200:Rethrow to preserve stack details")] [SuppressMessage("Design", "CA1031:Do not catch general exception types")]',
      ]),
    );
    assert.deepEqual(summarise(gained), ["src/Program.cs (SuppressMessage)"]);

    const justified = suppressions(
      hunk("src/Program.cs", [
        '-[SuppressMessage("Usage", "CA2200:Rethrow to preserve stack details")]',
        '+[SuppressMessage("Usage", "CA2200:Rethrow to preserve stack details", Justification = "tracked in ADR 12")]',
      ]),
    );
    assert.deepEqual(justified, []);
  });

  it("reads a severity stepped down to a level that still looks strict as a suppression", () => {
    // `error` -> `warning` leaves a line whose token both sides carry and whose value no
    // suppression pattern matches, but the diagnostic has stopped failing the build.
    const downgrade = suppressions(
      hunk(".editorconfig", [
        "-dotnet_diagnostic.CA1822.severity = error",
        "+dotnet_diagnostic.CA1822.severity = warning",
      ]),
    );
    assert.deepEqual(summarise(downgrade), [".editorconfig (diagnostic severity)"]);
    assert.equal(downgrade[0]?.line, "dotnet_diagnostic.CA1822.severity = warning");

    const upgrade = suppressions(
      hunk(".editorconfig", [
        "-dotnet_diagnostic.CA1822.severity = warning",
        "+dotnet_diagnostic.CA1822.severity = error",
      ]),
    );
    assert.deepEqual(upgrade, [], "a stricter severity is not a suppression");

    const respaced = suppressions(
      hunk(".editorconfig", [
        "-dotnet_diagnostic.CA1822.severity = error",
        "+dotnet_diagnostic.CA1822.severity=error",
      ]),
    );
    assert.deepEqual(respaced, [], "the same severity written differently is a reformat");
  });

  it("leaves a stronger audit configuration alone", () => {
    const found = suppressions(
      hunk("Directory.Build.props", [
        "+    <NuGetAuditMode>all</NuGetAuditMode>",
        "+    <NuGetAuditLevel>low</NuGetAuditLevel>",
      ]),
    );
    assert.deepEqual(found, []);
  });

  it("skips files the caller ignores", () => {
    const diff = hunk("obj/Debug/App.g.cs", ["+#pragma warning disable CS0618"]);
    assert.deepEqual(suppressions(diff, (f) => f.startsWith("obj/")), []);
    assert.equal(suppressions(diff).length, 1);
  });

  it("reads `+++` as a header only where the diff puts one", () => {
    const pathOnly = suppressions(hunk("build/NoWarn.props", ["+  <PropertyGroup>"]));
    assert.deepEqual(pathOnly, [], "a path containing NoWarn is not an added suppression");

    const content = suppressions(hunk("docs/notes.md", ["+++ NoWarn is off now"]));
    assert.deepEqual(content, [
      { file: "docs/notes.md", line: "++ NoWarn is off now", token: "NoWarn" },
    ]);
  });

  it("keeps a `-- `/`++ ` pair inside a hunk from rebinding the file", () => {
    // Content the writer controls: an adjacent removed/added pair that reads like a path header.
    // Binding to it would drop every later added line in the section, pragma included.
    const diff = [
      "diff --git a/test/App.Tests/Notes.md b/test/App.Tests/Notes.md",
      "index 28e1a8a..df22349 100644",
      "--- a/test/App.Tests/Notes.md",
      "+++ b/test/App.Tests/Notes.md",
      "@@ -2 +2 @@",
      "--- a/anything",
      "+++ /dev/null",
      "@@ -3,0 +4 @@ keep me",
      "+#pragma warning disable CS0618",
      "",
    ].join("\n");
    assert.deepEqual(summarise(suppressions(diff)), ["test/App.Tests/Notes.md (#pragma warning disable)"]);
  });

  it("attributes findings to the file section they appear in", () => {
    const diff = [
      hunk("A.csproj", ["+  <NoWarn>CS1591</NoWarn>"]),
      hunk("src/B.cs", ["+#pragma warning disable CS0618"]),
    ].join("");
    assert.deepEqual(
      suppressions(diff).map((s) => s.file),
      ["A.csproj", "src/B.cs"],
    );
  });

  it("reports one suppression per file and construct rather than one per line", () => {
    const lines = Array.from({ length: MAX_SUPPRESSIONS + 10 }, (_, i) => `+  <NoWarn>CS${1000 + i}</NoWarn>`);
    const report = findSuppressions(hunk("App.csproj", lines));
    assert.deepEqual(summarise(report.findings), ["App.csproj (NoWarn)"]);
    assert.equal(report.truncated, false);
  });

  it("flags the report as truncated when the cap drops a file, so the caller can refuse", () => {
    const diff = Array.from({ length: MAX_SUPPRESSIONS + 5 }, (_, i) =>
      hunk(`src/P${i}.csproj`, ["+  <NoWarn>CS1591</NoWarn>"]),
    ).join("");
    const report = findSuppressions(diff);
    assert.equal(report.findings.length, MAX_SUPPRESSIONS);
    assert.equal(report.truncated, true, "a partial report has to be distinguishable from a complete one");
  });
});

function deletedFile(file: string, lines: string[]): string {
  return [
    `diff --git a/${file} b/${file}`,
    "deleted file mode 100644",
    "index 1111111..0000000",
    `--- a/${file}`,
    "+++ /dev/null",
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines,
    "",
  ].join("\n");
}

describe("isTestPath", () => {
  it("accepts test directories, test projects, and test file names", () => {
    for (const p of [
      "test/Foo/BarTests.cs",
      "tests/BarTests.cs",
      "src/Test/Helpers/Builder.cs",
      "Foo.Tests/CalculatorTests.cs",
      "src/Foo.Test/Fixture.cs",
      "src/Foo.UnitTests/Fixture.cs",
      "src/Foo.IntegrationTests/Fixture.cs",
      "src/Domain/LedgerTest.cs",
      "src/Domain/LedgerSpec.cs",
      "src/Domain/LedgerSpecs.fs",
      "src/Domain/ledger_test.cs",
      "Tests.cs",
    ]) {
      assert.equal(isTestPath(p), true, `expected ${p} to be a test path`);
    }
  });

  it("accepts the test project names a .NET repository actually uses", () => {
    for (const p of [
      // A Hackney acceptance project holds *Steps.cs and *Fixtures.cs, so only the directory
      // name places these inside the suite.
      "src/Foo.AcceptanceTests/JourneySteps.cs",
      "src/Foo.FunctionalTests/Fixtures.cs",
      "src/Foo.E2ETests/Journey.cs",
      "src/Foo.ApiTests/Endpoints.cs",
      "src/Foo.Tests.Unit/Fixture.cs",
      "src/FooTests/Fixture.cs",
      "src/App.Testing/Harness.cs",
      "src/foo-tests/fixture.cs",
      // The project file names the suite where no directory does.
      "App.Tests.csproj",
      "FooTests.csproj",
      "src/Foo.AcceptanceTests/Foo.AcceptanceTests.csproj",
    ]) {
      assert.equal(isTestPath(p), true, `expected ${p} to be a test path`);
    }
  });

  it("rejects production paths that merely read like tests", () => {
    for (const p of [
      "src/Domain/Ledger.cs",
      "src/Testing/Harness.cs",
      "docker/latest/Dockerfile",
      "src/Contest/Entry.cs",
      "docs/testing.md",
      "src/Domain/TestHelpers.cs",
      // The basename rule, exercised: `test`/`spec` needs a boundary in front of it, or every
      // one of these production files is read as part of the suite.
      "src/Parsing/Latest.cs",
      "src/Domain/Greatest.cs",
      "src/Domain/Protest.cs",
      "src/Domain/Bespec.cs",
      "src/Domain/Latest.fs",
      "src/Latest/Manifest.cs",
      "App.csproj",
    ]) {
      assert.equal(isTestPath(p), false, `expected ${p} not to be a test path`);
    }
  });
});

describe("findTestWeakening", () => {
  it("reports a removed test attribute with its file, construct, and collapsed text", () => {
    const found = weakenings(hunk("test/Foo/BarTests.cs", ["-    [Fact]"]));
    assert.deepEqual(found, [{ file: "test/Foo/BarTests.cs", line: "[Fact]", token: "[Fact]" }]);
  });

  it("reports each removed attribute that unregisters a test", () => {
    const cases: [string, string][] = [
      ["-    [Test]", "[Test]"],
      ["-    [TestCase(1, 2)]", "[TestCase"],
      ["-    [Theory]", "[Theory]"],
      ["-    [TestMethod]", "[TestMethod]"],
      ['-    [Fact(DisplayName = "adds")]', "[Fact]"],
    ];
    for (const [line, token] of cases) {
      const found = weakenings(hunk("Foo.Tests/CalculatorTests.cs", [line]));
      assert.equal(found.length, 1, `expected ${line} to be reported`);
      assert.equal(found[0]?.token, token);
      assert.equal(found[0]?.file, "Foo.Tests/CalculatorTests.cs");
    }
  });

  it("reports each added construct that stops a test reporting failure", () => {
    const cases: [string, string][] = [
      ['+    [Fact(Skip = "flaky")]', "Skip ="],
      ['+    [Theory(SKIP="x")]', "Skip ="],
      ['+    [Fact ( skip\t= "x" )]', "Skip ="],
      ['+    [Ignore("net10 flaky")]', "[Ignore]"],
      ["+    [Explicit]", "[Explicit]"],
      ['+        Assert.Inconclusive("not on net10");', "Assert.Inconclusive"],
      ["+        Assert.Pass();", "Assert.Pass"],
    ];
    for (const [line, token] of cases) {
      const found = weakenings(hunk("tests/CalculatorTests.cs", [line]));
      assert.equal(found.length, 1, `expected ${line} to be reported`);
      assert.equal(found[0]?.token, token);
    }
  });

  it("reads a construct the writer split over several added lines", () => {
    const diff = hunk("tests/CalculatorTests.cs", [
      "-    [Fact]",
      "+    [Fact(",
      "+        Skip",
      '+        = "flaky")]',
    ]);
    assert.deepEqual(summarise(weakenings(diff)), ["tests/CalculatorTests.cs (Skip =)"]);
  });

  it("reports a deleted test file once, by its source path, not once per removed line", () => {
    const diff = deletedFile("test/Foo/BarTests.cs", [
      "-using Xunit;",
      "-    [Fact]",
      "-    public void Adds() => Assert.Equal(2, 1 + 1);",
      "-    [Theory]",
    ]);
    const found = weakenings(diff);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.file, "test/Foo/BarTests.cs");
    assert.equal(found[0]?.token, "deleted test file");
  });

  it("reports a test file renamed out of the build, from a real rename diff", () => {
    const parked = realDiff(TEST_REPO, (_repo, git) => {
      git(["mv", "test/App.Tests/CalculatorTests.cs", "test/App.Tests/CalculatorTests.cs.bak"]);
    });
    assert.match(parked, /^rename from /m, "the fixture has to be a real rename, not a delete plus an add");
    assert.deepEqual(summarise(weakenings(parked)), [
      "test/App.Tests/CalculatorTests.cs (test file renamed to an extension the build ignores)",
    ]);

    const moved = realDiff(TEST_REPO, (_repo, git) => {
      git(["mv", "test/App.Tests/CalculatorTests.cs", "src/App/CalculatorChecks.cs"]);
    });
    assert.deepEqual(summarise(weakenings(moved)), [
      "test/App.Tests/CalculatorTests.cs (test file moved out of the test suite)",
    ]);
  });

  it("reports a test project renamed out of the build", () => {
    const parked = realDiff(TEST_REPO, (_repo, git) => {
      git(["mv", "test/App.Tests/App.Tests.csproj", "test/App.Tests/App.Tests.csproj.disabled"]);
    });
    assert.deepEqual(summarise(weakenings(parked)), [
      "test/App.Tests/App.Tests.csproj (test file renamed to an extension the build ignores)",
    ]);
  });

  it("reads a diff with default context the same way it reads -U0", () => {
    const skipped = (context: boolean): string =>
      realDiff(
        TEST_REPO,
        (repo) => {
          edit(repo, "test/App.Tests/CalculatorTests.cs", "    [Fact]", '    [Fact(Skip = "net10")]');
        },
        { context },
      );
    assert.deepEqual(summarise(weakenings(skipped(false))), ["test/App.Tests/CalculatorTests.cs (Skip =)"]);
    assert.deepEqual(summarise(weakenings(skipped(true))), ["test/App.Tests/CalculatorTests.cs (Skip =)"]);
  });

  it("leaves an attribute the change only adds alone", () => {
    const reordered = realDiff(TEST_REPO, (repo) => {
      edit(repo, "test/App.Tests/CalculatorTests.cs", "    [Fact]", '    [Trait("cat", "unit")]\n    [Fact]');
    });
    assert.deepEqual(weakenings(reordered), []);
  });

  it("leaves a rename that keeps the file in the suite alone", () => {
    const renamed = realDiff(TEST_REPO, (repo, git) => {
      git(["mv", "test/App.Tests/CalculatorTests.cs", "test/App.Tests/CalcTests.cs"]);
      edit(repo, "test/App.Tests/CalcTests.cs", "class CalculatorTests", "class CalcTests");
    });
    assert.deepEqual(weakenings(renamed), []);
  });

  it("reports project plumbing that takes a whole suite out of the run", () => {
    const flagOff = realDiff(TEST_REPO, (repo) => {
      edit(repo, "test/App.Tests/App.Tests.csproj", "<IsTestProject>true", "<IsTestProject>false");
    });
    assert.deepEqual(summarise(weakenings(flagOff)), ["test/App.Tests/App.Tests.csproj (IsTestProject)"]);

    const excluded = realDiff(TEST_REPO, (repo) => {
      edit(
        repo,
        "test/App.Tests/App.Tests.csproj",
        "  <ItemGroup>\n    <PackageReference",
        '  <ItemGroup>\n    <Compile Remove="CalculatorTests.cs" />\n  </ItemGroup>\n  <ItemGroup>\n    <PackageReference',
      );
    });
    assert.deepEqual(summarise(weakenings(excluded)), ["test/App.Tests/App.Tests.csproj (<Compile Remove>)"]);

    const unreferenced = realDiff(TEST_REPO, (repo) => {
      edit(
        repo,
        "test/App.Tests/App.Tests.csproj",
        '  <ItemGroup>\n    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />\n  </ItemGroup>\n',
        "",
      );
    });
    assert.deepEqual(summarise(weakenings(unreferenced)), ["test/App.Tests/App.Tests.csproj (<ProjectReference>)"]);

    const unlisted = realDiff(TEST_REPO, (repo) => {
      edit(
        repo,
        "App.sln",
        'Project("{FAE04EC0}") = "App.Tests", "test\\App.Tests\\App.Tests.csproj", "{BBB}"\nEndProject\n',
        "",
      );
    });
    assert.deepEqual(summarise(weakenings(unlisted)), ["App.sln (solution test project)"]);

    const filtered = realDiff(TEST_REPO, (repo) => {
      edit(
        repo,
        "Directory.Build.props",
        "  </PropertyGroup>",
        "    <VSTestTestCaseFilter>Category!=Broken</VSTestTestCaseFilter>\n  </PropertyGroup>",
      );
    });
    assert.deepEqual(summarise(weakenings(filtered)), ["Directory.Build.props (test case filter)"]);
  });

  it("leaves ordinary project edits alone", () => {
    const retarget = realDiff(TEST_REPO, (repo) => {
      edit(repo, "test/App.Tests/App.Tests.csproj", "net6.0", "net10.0");
      edit(repo, "test/App.Tests/App.Tests.csproj", 'Version="2.4.2"', 'Version="2.9.2"');
    });
    assert.deepEqual(weakenings(retarget), []);
    assert.deepEqual(suppressions(retarget), []);
  });

  it("reports a deleted test whose basename is not *Tests.cs, because its project is a suite", () => {
    const steps = { "src/Foo.AcceptanceTests/JourneySteps.cs": "[Test] public void Journey() { }\n" };
    const deleted = realDiff({ ...TEST_REPO, ...steps }, (repo) => {
      fs.rmSync(path.join(repo, "src/Foo.AcceptanceTests/JourneySteps.cs"));
    });
    assert.deepEqual(summarise(weakenings(deleted)), [
      "src/Foo.AcceptanceTests/JourneySteps.cs (deleted test file)",
    ]);

    const ignored = realDiff({ ...TEST_REPO, ...steps }, (repo) => {
      edit(repo, "src/Foo.AcceptanceTests/JourneySteps.cs", "[Test]", '[Test] [Ignore("net10")]');
    });
    assert.deepEqual(summarise(weakenings(ignored)), ["src/Foo.AcceptanceTests/JourneySteps.cs ([Ignore])"]);
  });

  it("leaves production code alone: the same constructs outside the test suite are in scope for the change", () => {
    const removed = weakenings(hunk("src/Domain/Ledger.cs", ["-    [Fact]", "-    [TestCase(1)]"]));
    assert.deepEqual(removed, []);
    const addedLines = ['+    var url = $"{Host}?Skip = 1";', '+    [Ignore("x")]', "+    Assert.Inconclusive();"];
    assert.deepEqual(weakenings(hunk("src/Domain/Ledger.cs", addedLines)), []);
    assert.deepEqual(weakenings(deletedFile("src/Domain/Ledger.cs", ["-    [Fact]"])), []);
    assert.deepEqual(
      weakenings(hunk("src/Parsing/SkipWhitespace.cs", ["+    public int Skip = 0;", "-    [Test]"])),
      [],
    );
  });

  it("leaves a production file whose name merely ends in test alone when it is deleted", () => {
    assert.deepEqual(weakenings(deletedFile("src/Parsing/Latest.cs", ["-public static class Latest { }"])), []);
  });

  it("reads a construct in a test file, not one a test file describes", () => {
    // A new test asserting on the text `Skip = 0` adds no skip; neither does a note in the docs
    // that sit beside the suite, nor a JSON fixture under it.
    const literal = weakenings(
      hunk("test/App.Tests/UrlTests.cs", [
        '+    public void BuildsQuery() => Assert.Equal("?Skip = 0", Build());',
        '+    static string Build() => "?Skip = 0";',
        '+    // [Fact(Skip = "documented, not applied")]',
      ]),
    );
    assert.deepEqual(literal, []);

    assert.deepEqual(weakenings(hunk("test/App.Tests/docs/README.md", ['+Never write `Skip = "flaky"` here.'])), []);
    assert.deepEqual(weakenings(hunk("test/fixtures/data.json", ['+  "Skip = 1": true'])), []);
    assert.deepEqual(weakenings(deletedFile("test/App.Tests/docs/README.md", ["-notes"])), []);
  });

  it("leaves a moved assertion alone, since refactors move them and a gate on that gets switched off", () => {
    const diff = hunk("test/Foo/BarTests.cs", [
      "-        Assert.Equal(2, sut.Add(1, 1));",
      "-        Assert.NotNull(sut);",
      "+        sut.Add(1, 1).Should().Be(2);",
    ]);
    assert.deepEqual(weakenings(diff), []);
  });

  it("leaves a reformat alone: an attribute the file keeps was not removed", () => {
    const reindented = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "test/App.Tests/CalculatorTests.cs");
      const text = fs.readFileSync(file, "utf8").replace(/^ {4}/gm, "  ").replace(/^ {8}/gm, "    ");
      fs.writeFileSync(file, text);
    });
    assert.deepEqual(weakenings(reindented), []);

    const fileScoped = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "test/App.Tests/CalculatorTests.cs");
      const text = fs.readFileSync(file, "utf8").replace("namespace App.Tests;", "namespace App.Tests;\n");
      fs.writeFileSync(file, text.replace(/^ {4}\[/gm, "[").replace(/^ {4}public/gm, "public"));
    });
    assert.deepEqual(weakenings(fileScoped), []);

    const collapsed = realDiff(TEST_REPO, (repo) => {
      edit(repo, "test/App.Tests/CalculatorTests.cs", "    [Theory]\n    [InlineData(1)]", "    [Theory, InlineData(1)]");
    });
    assert.deepEqual(weakenings(collapsed), []);

    const lineEndings = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "test/App.Tests/CalculatorTests.cs");
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
    });
    assert.deepEqual(weakenings(lineEndings), []);
  });

  it("still reports a test the reformat dropped on its way past", () => {
    const diff = realDiff(TEST_REPO, (repo) => {
      const file = path.join(repo, "test/App.Tests/CalculatorTests.cs");
      const text = fs
        .readFileSync(file, "utf8")
        .replace(/^ {4}/gm, "  ")
        .replace(/^ {8}/gm, "    ")
        .replace("  [Theory]\n", "");
      fs.writeFileSync(file, text);
    });
    assert.deepEqual(summarise(weakenings(diff)), ["test/App.Tests/CalculatorTests.cs ([Theory])"]);
  });

  it("reads a weakening through a BOM, CRLF line endings, and a binary blob before it", () => {
    const bom = "\ufeffusing Xunit;\npublic class BomTests\n{\n    [Fact]\n    public void Works() { }\n}\n";
    const diff = realDiff(
      { ...TEST_REPO, "test/App.Tests/BomTests.cs": bom, "test/App.Tests/blob.bin": "\u0000\u0001seed" },
      (repo) => {
        fs.writeFileSync(path.join(repo, "test/App.Tests/blob.bin"), Buffer.from([0, 1, 2, 3, 255]));
        const file = path.join(repo, "test/App.Tests/BomTests.cs");
        const text = fs.readFileSync(file, "utf8").replace("[Fact]", '[Fact(Skip = "net10")]');
        fs.writeFileSync(file, text.replace(/\n/g, "\r\n"));
      },
    );
    assert.deepEqual(summarise(weakenings(diff)), ["test/App.Tests/BomTests.cs (Skip =)"]);
  });

  it("leaves a legitimately added test file and a regenerated artefact alone", () => {
    const added = realDiff(TEST_REPO, (repo) => {
      writeFiles(repo, {
        "test/App.Tests/NewFeatureTests.cs": "using Xunit;\npublic class NewFeatureTests\n{\n    [Fact]\n    public void HandlesNet10() { }\n}\n",
        "test/App.Tests/obj/Debug/Gen.cs": "#pragma warning disable CS0618\n// [Fact] removed by the generator\n",
      });
    });
    assert.deepEqual(weakenings(added, (f) => f.includes("/obj/")), []);
    assert.deepEqual(suppressions(added, (f) => f.includes("/obj/")), []);
  });

  it("reads path lines as headers only where the diff puts them", () => {
    const diff = hunk("test/Foo/BarTests.cs", [
      "+// --- migration notes: see src/Elsewhere.cs",
      "+--- a/src/Elsewhere.cs",
      "+++ b/src/Elsewhere.cs",
      "--- a/src/Elsewhere.cs",
      "-    [Fact]",
    ]);
    assert.deepEqual(weakenings(diff), [
      { file: "test/Foo/BarTests.cs", line: "[Fact]", token: "[Fact]" },
    ]);
  });

  it("attributes findings to the file section they appear in", () => {
    const diff = [
      hunk("test/ATests.cs", ["-    [Fact]"]),
      hunk("src/Domain/Ledger.cs", ["-    [Fact]"]),
      hunk("Foo.Tests/BTests.cs", ['+    [Fact(Skip = "flaky")]']),
    ].join("");
    assert.deepEqual(
      weakenings(diff).map((w) => w.file),
      ["test/ATests.cs", "Foo.Tests/BTests.cs"],
    );
  });

  it("skips files the caller ignores", () => {
    const diff = hunk("test/obj/Debug/GeneratedTests.cs", ["-    [Fact]"]);
    assert.deepEqual(weakenings(diff, (f) => f.includes("/obj/")), []);
    assert.equal(weakenings(diff).length, 1);

    const deleted = deletedFile("test/obj/Debug/GeneratedTests.cs", ["-    [Fact]"]);
    assert.deepEqual(weakenings(deleted, (f) => f.includes("/obj/")), []);
  });

  it("clips a long line but keeps the part that identifies it", () => {
    const long = `-    [Fact(DisplayName = "${"a".repeat(300)}")]`;
    const clipped = weakenings(hunk("test/BarTests.cs", [long]))[0]?.line ?? "";
    assert.ok(clipped.startsWith('[Fact(DisplayName = "aaa'), "the construct has to survive the clip");
    assert.ok(clipped.length <= MAX_TEST_WEAKENING_CHARS + 1);
    assert.equal(clipped.endsWith("…"), true);
  });

  it("keeps noise in one file from crowding the real weakening out of the report", () => {
    // Diff order is alphabetical and the writer names the files, so 60 skips in a file it can
    // justify would otherwise fill the report and hide the one it cannot.
    const diff = realDiff(TEST_REPO, (repo) => {
      const noise = Array.from(
        { length: MAX_TEST_WEAKENINGS + 10 },
        (_, i) => `    [Fact(Skip = "noise ${i}")]\n    public void Noise${i}() { }\n`,
      ).join("");
      const file = path.join(repo, "test/App.Tests/CalculatorTests.cs");
      fs.writeFileSync(file, `${fs.readFileSync(file, "utf8").trimEnd().slice(0, -1)}${noise}}\n`);
      writeFiles(repo, {
        "test/App.Tests/LedgerTests.cs": 'using Xunit;\npublic class LedgerTests\n{\n    [Fact(Skip = "the real cheat")]\n    public void Balances() { }\n}\n',
      });
    });
    const report = findTestWeakening(diff);
    assert.equal(report.truncated, false);
    assert.deepEqual(summarise(report.findings), [
      "test/App.Tests/CalculatorTests.cs (Skip =)",
      "test/App.Tests/LedgerTests.cs (Skip =)",
    ]);
  });

  it("flags the report as truncated when the cap drops a file, so the caller can refuse", () => {
    const diff = Array.from({ length: MAX_TEST_WEAKENINGS + 5 }, (_, i) =>
      hunk(`test/T${i}Tests.cs`, ["-    [Fact]"]),
    ).join("");
    const report = findTestWeakening(diff);
    assert.equal(report.findings.length, MAX_TEST_WEAKENINGS);
    assert.equal(report.truncated, true, "a partial report has to be distinguishable from a complete one");
  });

  it("reports nothing for an empty diff", () => {
    assert.deepEqual(findTestWeakening(""), { findings: [], truncated: false });
  });
});

describe("unquoteGitPath", () => {
  it("decodes the octal escapes git writes for a path outside printable ASCII", () => {
    assert.equal(unquoteGitPath('"tests/Caf\\303\\251.Tests/LedgerTests.cs"'), "tests/Café.Tests/LedgerTests.cs");
    assert.equal(unquoteGitPath('"src/a\\tb\\\\c\\"d.cs"'), 'src/a\tb\\c"d.cs');
    assert.equal(unquoteGitPath("src/Plain.cs"), "src/Plain.cs");
    assert.equal(unquoteGitPath(""), "");
  });

  it("reports a quoted path by its real name, so a manifest is parsed and a finding can be matched", () => {
    const accented = {
      "src/Café.Api/Café.Api.csproj": '<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n  </ItemGroup>\n</Project>\n',
      "tests/Café.Tests/LedgerTests.cs": "using Xunit;\npublic class LedgerTests\n{\n    [Fact]\n    public void Balances() { }\n}\n",
    };
    const diff = realDiff({ ...TEST_REPO, ...accented }, (repo) => {
      edit(repo, "src/Café.Api/Café.Api.csproj", "  <ItemGroup>", '  <ItemGroup>\n    <PackageReference Include="Smuggled.Pkg" Version="1.0.0" />');
      edit(repo, "tests/Café.Tests/LedgerTests.cs", "[Fact]", '[Fact(Skip = "net10")]');
    });
    assert.match(diff, /"a\/src\/Caf/, "the fixture has to be a diff git actually quoted");
    assert.deepEqual(summarise(weakenings(diff)), ["tests/Café.Tests/LedgerTests.cs (Skip =)"]);
    assert.equal(isPackageManifest("src/Café.Api/Café.Api.csproj"), true);
  });
});
