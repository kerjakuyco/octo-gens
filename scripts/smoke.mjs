// Starts the built desktop app with an empty data folder and waits for proof
// that the real web view loaded the bundled interface and reached the core:
// the interface calls `boot` on start, which marks the sample paper book.
//
//   node scripts/smoke.mjs [path-to-binary] [--e2e]
//
// With --e2e (debug builds only) the app also drives one paper order through
// its own window: it types "buy 0.01 BTC", sends it and confirms the ticket.
// The test then waits for that fill to appear in the run journal.
//
// Exits 0 on success, 1 if the app exits early or 40 seconds pass.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executable = process.platform === "win32" ? "octo-gens.exe" : "octo-gens";
const e2e = process.argv.includes("--e2e");
const given = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const binary = given ?? (e2e ? ["debug"] : ["release", "debug"]).map((profile) => join("target", profile, executable)).find(existsSync);
if (!binary || !existsSync(binary)) {
  console.error("No built app found. Run `pnpm tauri build` first, or pass the binary path.");
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "octogens-smoke-"));
const env = { ...process.env, OCTOGENS_DATA_DIR: dataDir, ...(e2e ? { OCTOGENS_SELFTEST: "1" } : {}) };
const app = spawn(binary, [], { env, stdio: "inherit" });
let exited = null;
app.on("exit", (code) => (exited = code ?? 1));

const ledger = join(dataDir, "spot-usdt-sample.sqlite3");
const journal = join(dataDir, "journal.sqlite3");
// SQLite keeps text as UTF-8, so these are visible without a database driver.
const holds = (file, ...needles) => existsSync(file) && needles.every((needle) => readFileSync(file).includes(needle));
const booted = () => {
  if (!holds(ledger, "BTC/USDT", "84215.50")) return false;
  return !e2e || holds(journal, "Paper fill: buy 0.01 BTC/USDT at 84,215.50 USDT.");
};

const finish = (code, message) => {
  console.log(message);
  if (exited === null) app.kill();
  setTimeout(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.exit(code);
  }, 500);
};

const deadline = Date.now() + 40_000;
const timer = setInterval(() => {
  if (booted()) {
    clearInterval(timer);
    const proof = e2e ? "placed a paper order through its own window" : "started and its interface reached the core";
    finish(0, `Smoke test passed: ${binary} ${proof}.`);
  } else if (exited !== null) {
    clearInterval(timer);
    finish(1, `Smoke test failed: the app exited with code ${exited} before its interface loaded.`);
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    finish(1, "Smoke test failed: the interface did not reach the core within 40 seconds.");
  }
}, 200);
