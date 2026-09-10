import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  capDependencyChanges,
  diffManifests,
  emptyDependencyChanges,
  isPackageManifest,
  MAX_MANIFEST_BYTES,
  parseDockerImages,
  parsePackageVersions,
  parseSdkPin,
  parseTargetFrameworks,
} from "../src/packages";

function csproj(body: string): string {
  return `<Project Sdk="Microsoft.NET.Sdk">\n${body}\n</Project>\n`;
}

describe("isPackageManifest", () => {
  it("accepts project files, props, global.json, lock files, and Dockerfiles", () => {
    for (const p of [
      "App.csproj",
      "src/Lib.fsproj",
      "src/Old.vbproj",
      "Directory.Packages.props",
      "src/Directory.Build.props",
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
