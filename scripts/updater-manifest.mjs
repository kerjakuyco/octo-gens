#!/usr/bin/env node
/**
 * Builds Tauri's `latest.json` updater manifest from signed release artifacts
 * collected across macOS, Windows, and Linux matrix jobs.
 *
 * Usage:
 *   node scripts/updater-manifest.mjs \
 *     --version 0.7.0 \
 *     --tag v0.7.0 \
 *     --repo kerjakuyco/octo-neo \
 *     --dir ./artifacts \
 *     --notes-file ./notes.md \
 *     --out ./latest.json
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Walks `dir` recursively and returns all file paths in deterministic order. */
function walk(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else if (entry.isFile()) results.push(full);
  }
  return results.sort();
}

/** GitHub replaces spaces in uploaded release asset filenames with dots. */
export function githubAssetName(filename) {
  return filename.replace(/\s+/g, ".");
}

/** Maps a signed updater artifact filename to the Tauri v2 `latest.json` target keys. */
export function platformKeysForAsset(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".app.tar.gz")) {
    if (lower.includes("x64") || lower.includes("x86_64")) return ["darwin-x86_64"];
    return ["darwin-aarch64"];
  }
  if (lower.endsWith(".exe")) {
    return ["windows-x86_64-nsis", "windows-x86_64"];
  }
  if (lower.endsWith(".msi")) {
    return ["windows-x86_64-msi"];
  }
  if (lower.endsWith(".appimage")) {
    return ["linux-x86_64-appimage", "linux-x86_64"];
  }
  if (lower.endsWith(".deb")) {
    return ["linux-x86_64-deb"];
  }
  if (lower.endsWith(".rpm")) {
    return ["linux-x86_64-rpm"];
  }
  return [];
}

/**
 * Builds the `latest.json` object from a directory of downloaded workflow artifacts.
 *
 * Returns `null` when no `.sig` files are present (for example when a repository
 * has not configured `TAURI_SIGNING_PRIVATE_KEY` yet).
 */
export function buildUpdaterManifest({
  version,
  tag,
  repo,
  dir,
  notes = "",
  pubDate = new Date().toISOString(),
}) {
  const cleanVersion = version.trim().replace(/^v/i, "");
  if (!cleanVersion) throw new Error("Missing --version.");
  if (!tag) throw new Error("Missing --tag.");
  if (!repo) throw new Error("Missing --repo.");

  const files = walk(dir);
  const sigFiles = files.filter((file) => file.endsWith(".sig"));
  if (sigFiles.length === 0) return null;

  const platforms = {};
  let msiEntry = null;

  for (const sigPath of sigFiles) {
    const assetPath = sigPath.slice(0, -4);
    const assetName = basename(assetPath);
    const keys = platformKeysForAsset(assetName);
    if (keys.length === 0) continue;

    // Ensure the matching binary exists alongside its signature.
    let assetExists = false;
    try {
      assetExists = statSync(assetPath).isFile();
    } catch {
      assetExists = false;
    }
    if (!assetExists) {
      throw new Error(`Signature ${sigPath} is missing its matching artifact ${assetPath}.`);
    }

    const signature = readFileSync(sigPath, "utf8").trim();
    if (!signature) {
      throw new Error(`Signature file ${sigPath} is empty.`);
    }

    const encodedAsset = encodeURIComponent(githubAssetName(assetName));
    const url = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodedAsset}`;
    const entry = { signature, url };

    for (const key of keys) {
      platforms[key] = entry;
    }
    if (assetName.toLowerCase().endsWith(".msi")) {
      msiEntry = entry;
    }
  }

  // Fall back to MSI for the generic Windows key only if no NSIS bundle was built.
  if (!platforms["windows-x86_64"] && msiEntry) {
    platforms["windows-x86_64"] = msiEntry;
  }

  const orderedPlatforms = Object.fromEntries(
    Object.entries(platforms).sort(([a], [b]) => a.localeCompare(b)),
  );
  if (Object.keys(orderedPlatforms).length === 0) return null;

  return {
    version: cleanVersion,
    notes: notes.trim(),
    pub_date: pubDate,
    platforms: orderedPlatforms,
  };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = "true";
    } else {
      args[key] = value;
      i += 1;
    }
  }
  return args;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const notes = args["notes-file"] ? readFileSync(args["notes-file"], "utf8") : (args.notes ?? "");
  const manifest = buildUpdaterManifest({
    version: args.version ?? "",
    tag: args.tag ?? "",
    repo: args.repo ?? "",
    dir: args.dir ?? ".",
    notes,
    pubDate: args["pub-date"] ?? new Date().toISOString(),
  });

  if (!manifest) {
    console.log("No signed updater artifacts found; skipping latest.json generation.");
    process.exit(0);
  }

  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.out) {
    writeFileSync(args.out, output, "utf8");
    console.log(`Wrote ${args.out} with ${Object.keys(manifest.platforms).length} platform entries.`);
  } else {
    process.stdout.write(output);
  }
}
