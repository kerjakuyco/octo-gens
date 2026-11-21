import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildUpdaterManifest,
  changelogSection,
  githubAssetName,
  missingPlatforms,
  parsePlatformList,
  platformKeysForAsset,
} from "./updater-manifest.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "octoneo-manifest-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("updater-manifest script", () => {
  it("maps macOS, Windows, and Linux signed bundles to Tauri v2 platform keys", () => {
    assert.deepEqual(platformKeysForAsset("OctoNeo_aarch64.app.tar.gz"), ["darwin-aarch64"]);
    assert.deepEqual(platformKeysForAsset("OctoNeo_0.7.0_x64-setup.exe"), ["windows-x86_64-nsis", "windows-x86_64"]);
    assert.deepEqual(platformKeysForAsset("OctoNeo_0.7.0_x64_en-US.msi"), ["windows-x86_64-msi"]);
    assert.deepEqual(platformKeysForAsset("OctoNeo_0.7.0_amd64.AppImage"), ["linux-x86_64-appimage", "linux-x86_64"]);
    assert.deepEqual(platformKeysForAsset("OctoNeo_0.7.0_amd64.deb"), ["linux-x86_64-deb"]);
    assert.deepEqual(platformKeysForAsset("OctoNeo-0.7.0-1.x86_64.rpm"), ["linux-x86_64-rpm"]);
    assert.equal(githubAssetName("OctoNeo 0.7.0.dmg"), "OctoNeo.0.7.0.dmg");
  });

  it("builds a merged multi-platform latest.json manifest from artifact directories", () => {
    const dir = makeTempDir();
    const mac = join(dir, "octoneo-macos-arm64");
    const win = join(dir, "octoneo-windows-x64");
    const lin = join(dir, "octoneo-linux-x64");
    mkdirSync(mac);
    mkdirSync(win);
    mkdirSync(lin);

    const artifacts = [
      [mac, "OctoNeo.app.tar.gz", "MAC_SIG"],
      [win, "OctoNeo_0.7.0_x64-setup.exe", "WIN_NSIS_SIG"],
      [win, "OctoNeo_0.7.0_x64_en-US.msi", "WIN_MSI_SIG"],
      [lin, "OctoNeo_0.7.0_amd64.AppImage", "LIN_APPIMAGE_SIG"],
      [lin, "OctoNeo_0.7.0_amd64.deb", "LIN_DEB_SIG"],
      [lin, "OctoNeo-0.7.0-1.x86_64.rpm", "LIN_RPM_SIG"],
    ];
    for (const [folder, file, sig] of artifacts) {
      writeFileSync(join(folder, file), "binary");
      writeFileSync(join(folder, `${file}.sig`), `${sig}\n`);
    }

    const manifest = buildUpdaterManifest({
      version: "v0.7.0",
      tag: "v0.7.0",
      repo: "kerjakuyco/octo-neo",
      dir,
      notes: "  Release notes body\n",
      pubDate: "2026-11-20T00:00:00Z",
    });

    assert.deepEqual(manifest, {
      version: "0.7.0",
      notes: "Release notes body",
      pub_date: "2026-11-20T00:00:00Z",
      platforms: {
        "darwin-aarch64": {
          signature: "MAC_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo.app.tar.gz",
        },
        "linux-x86_64": {
          signature: "LIN_APPIMAGE_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_amd64.AppImage",
        },
        "linux-x86_64-appimage": {
          signature: "LIN_APPIMAGE_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_amd64.AppImage",
        },
        "linux-x86_64-deb": {
          signature: "LIN_DEB_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_amd64.deb",
        },
        "linux-x86_64-rpm": {
          signature: "LIN_RPM_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo-0.7.0-1.x86_64.rpm",
        },
        "windows-x86_64": {
          signature: "WIN_NSIS_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_x64-setup.exe",
        },
        "windows-x86_64-msi": {
          signature: "WIN_MSI_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_x64_en-US.msi",
        },
        "windows-x86_64-nsis": {
          signature: "WIN_NSIS_SIG",
          url: "https://github.com/kerjakuyco/octo-neo/releases/download/v0.7.0/OctoNeo_0.7.0_x64-setup.exe",
        },
      },
    });
  });

  it("returns null when no signature files exist (unsigned release)", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "OctoNeo_0.7.0_aarch64.dmg"), "dmg");
    assert.equal(
      buildUpdaterManifest({
        version: "0.7.0",
        tag: "v0.7.0",
        repo: "kerjakuyco/octo-neo",
        dir,
      }),
      null,
    );
  });

  it("throws when a .sig file has no matching binary artifact", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "OctoNeo.app.tar.gz.sig"), "ORPHAN_SIG");
    assert.throws(
      () =>
        buildUpdaterManifest({
          version: "0.7.0",
          tag: "v0.7.0",
          repo: "kerjakuyco/octo-neo",
          dir,
        }),
      /missing its matching artifact/,
    );
  });

  it("takes a version's notes from its CHANGELOG.md section", () => {
    const changelog = [
      "# Changelog",
      "",
      "## Unreleased",
      "",
      "## 0.10.2",
      "",
      "Updates that install themselves.",
      "",
      "### Changed",
      "",
      "- **Updates.** They download in the background.",
      "",
      "## 0.10.1",
      "",
      "The wallet pages, redesigned.",
      "",
    ].join("\n");
    assert.equal(
      changelogSection(changelog, "0.10.2"),
      "Updates that install themselves.\n\n### Changed\n\n- **Updates.** They download in the background.",
    );
    assert.equal(changelogSection(changelog, "v0.10.1"), "The wallet pages, redesigned.");
    assert.equal(changelogSection(changelog, "0.10.20"), null);
    assert.equal(changelogSection(changelog, "0.10"), null);
    assert.equal(changelogSection("## [1.0.0] - 2026-01-01\n\nFirst.\r\n", "1.0.0"), "First.");
  });

  it("lists the required platforms a manifest lacks", () => {
    const manifest = { platforms: { "darwin-aarch64": {}, "windows-x86_64": {} } };
    assert.deepEqual(parsePlatformList(" darwin-aarch64, windows-x86_64-msi ,,linux-x86_64 "), [
      "darwin-aarch64",
      "windows-x86_64-msi",
      "linux-x86_64",
    ]);
    assert.deepEqual(missingPlatforms(manifest, ["darwin-aarch64", "windows-x86_64-msi", "linux-x86_64"]), [
      "windows-x86_64-msi",
      "linux-x86_64",
    ]);
    assert.deepEqual(missingPlatforms(manifest, []), []);
    assert.deepEqual(missingPlatforms(null, ["darwin-aarch64"]), ["darwin-aarch64"]);
  });

  describe("command line", () => {
    const script = fileURLToPath(new URL("./updater-manifest.mjs", import.meta.url));
    const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

    function artifacts(names) {
      const dir = makeTempDir();
      for (const name of names) {
        writeFileSync(join(dir, name), "binary");
        writeFileSync(join(dir, `${name}.sig`), "SIG\n");
      }
      return dir;
    }

    function changelogFile(text) {
      const file = join(makeTempDir(), "CHANGELOG.md");
      writeFileSync(file, text);
      return file;
    }

    const base = (dir) => ["--version", "0.10.2", "--tag", "v0.10.2", "--repo", "kerjakuyco/octo-neo", "--dir", dir];

    it("writes the CHANGELOG section as the notes", () => {
      const dir = artifacts(["OctoNeo.app.tar.gz"]);
      const out = join(makeTempDir(), "latest.json");
      const changelog = changelogFile("## 0.10.2\n\nUpdates that install themselves.\n\n## 0.10.1\n\nOlder.\n");
      const result = run([...base(dir), "--changelog", changelog, "--require", "darwin-aarch64", "--out", out]);
      assert.equal(result.status, 0, result.stderr);
      const manifest = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(manifest.notes, "Updates that install themselves.");
      assert.deepEqual(Object.keys(manifest.platforms), ["darwin-aarch64"]);
    });

    it("fails when the CHANGELOG has no section for the version", () => {
      const dir = artifacts(["OctoNeo.app.tar.gz"]);
      const out = join(makeTempDir(), "latest.json");
      const result = run([...base(dir), "--changelog", changelogFile("## 0.10.1\n\nOlder.\n"), "--out", out]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /no section for 0\.10\.2/);
      assert.equal(existsSync(out), false);
    });

    it("fails instead of writing a manifest that lacks a required platform", () => {
      const dir = artifacts(["OctoNeo.app.tar.gz", "OctoNeo_0.10.2_x64-setup.exe"]);
      const out = join(makeTempDir(), "latest.json");
      const result = run([
        ...base(dir),
        "--require",
        "darwin-aarch64,windows-x86_64-nsis,windows-x86_64-msi,linux-x86_64-appimage",
        "--out",
        out,
      ]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /windows-x86_64-msi, linux-x86_64-appimage/);
      assert.equal(existsSync(out), false);
    });

    it("fails when nothing was signed although platforms are required", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "OctoNeo_0.10.2_aarch64.dmg"), "dmg");
      const result = run([...base(dir), "--require", "darwin-aarch64"]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /No signed updater artifacts/);
    });

    it("skips quietly when nothing was signed and nothing is required", () => {
      const dir = makeTempDir();
      writeFileSync(join(dir, "OctoNeo_0.10.2_aarch64.dmg"), "dmg");
      const result = run(base(dir));
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /skipping latest\.json/);
    });
  });
});
