import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { buildUpdaterManifest, githubAssetName, platformKeysForAsset } from "./updater-manifest.mjs";

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
});
