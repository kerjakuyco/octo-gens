import { REPO, RELEASES, ISSUES, VERSION, code, doc, docPage, esc, facts, out, shell } from "../site.mjs";

/** Where the installers of this version are attached, and the release they belong to. */
const FILES = `${RELEASES}/download/v${VERSION}`;
const RELEASE = `${RELEASES}/tag/v${VERSION}`;
const RELEASED = "November 20, 2026";

/**
 * The installers, by system. The first file of each is the one most people want, drawn as the white
 * button; the others are dark. Every name is a file attached to the release.
 */
const PLATFORMS = [
  {
    id: "windows",
    name: "Windows",
    detail: "64-bit",
    files: [
      [`OctoNeo_${VERSION}_x64-setup.exe`, "Installer (.exe)"],
      [`OctoNeo_${VERSION}_x64_en-US.msi`, "MSI package (.msi)"],
    ],
  },
  {
    id: "macos",
    name: "macOS",
    detail: "Apple silicon, M1 and later",
    files: [[`OctoNeo_${VERSION}_aarch64.dmg`, "Disk image (.dmg)"]],
    note: `No installer for Intel Macs: <a href="#build">build it from source</a> on one.`,
  },
  {
    id: "linux",
    name: "Linux",
    detail: "64-bit",
    files: [
      [`OctoNeo_${VERSION}_amd64.AppImage`, "AppImage, any distribution"],
      [`OctoNeo_${VERSION}_amd64.deb`, "Debian or Ubuntu (.deb)"],
      [`OctoNeo-${VERSION}-1.x86_64.rpm`, "Fedora or openSUSE (.rpm)"],
    ],
  },
];

const platform = (p) => `<section class="platform" aria-labelledby="platform-${p.id}">
<h2 class="platform-name" id="platform-${p.id}">${p.name}</h2>
<p class="platform-detail">${p.detail}</p>
<ul class="platform-files">
${p.files
  .map(
    ([name, label], index) =>
      `<li><a class="button ${index === 0 ? "button-brand" : "button-quiet"}" href="${esc(`${FILES}/${name}`)}">${label}</a></li>`,
  )
  .join("\n")}
</ul>
${p.note ? `<p class="platform-note">${p.note}</p>` : ""}
<p class="platform-names">${p.files.map(([name]) => `<code>${esc(name)}</code>`).join("")}</p>
</section>`;

const INSTALLERS = `<div class="platforms" id="download">
${PLATFORMS.map(platform).join("\n")}
</div>
<p class="platforms-note">Every installer is built from this repository by GitHub Actions, and the ${out(RELEASE, "release page")} lists each file’s <span class="nowrap">SHA-256</span> checksum.</p>`;

/** Numbered steps: a real sequence, done in this order. */
const steps = (items) => `<ol class="steps-list">
${items.map((item) => `<li>${item}</li>`).join("\n")}
</ol>`;

export default {
  path: "/download/",
  title: "Download OctoNeo",
  description: `Download OctoNeo ${VERSION} for Windows, macOS or Linux, or build it from source. What to expect at the first launch, and how to start.`,
  render: () =>
    docPage({
      path: "/download/",
      title: "Download OctoNeo",
      lead: `Version ${VERSION} for Windows, macOS and Linux. Download the installer for your system, or build it from source.`,
      buttons: "",
      meta: `<span>Version ${VERSION}</span><span>Released ${RELEASED}</span><span>GPL-3.0-only</span>${out(RELEASE, "Release notes")}`,
      visual: INSTALLERS,
      sections: [
        {
          id: "install",
          title: "Install",
          body: `${facts(
            [
              ["macOS", "Open the disk image and drag OctoNeo to Applications."],
              ["Linux", `Make the AppImage executable (${code("chmod +x")}) and run it, or install the package for your distribution.`],
              ["Every file", `All files and notes are on the ${out(RELEASE, "release page")}.`],
            ],
          )}
<p>There is no installer for Intel Macs; you can <a href="#build">build OctoNeo from source</a> on one.</p>`,
        },
        {
          id: "build",
          title: "Build from source",
          lead: "You need four things, and no wallet or model key to build or to run the tests.",
          body: `${facts([
            ["Rust", `The stable toolchain, from ${out("https://rustup.rs", "rustup.rs")}`],
            ["Node.js", `Version 20 or newer, from ${out("https://nodejs.org", "nodejs.org")}`],
            ["pnpm", `Version 10, from ${out("https://pnpm.io", "pnpm.io")}`],
            ["Tauri’s system dependencies", `For your platform, as listed in ${out("https://tauri.app/start/prerequisites/", "Tauri’s prerequisites")}`],
          ])}
${shell(
  [
    "git clone https://github.com/kerjakuyco/octo-neo.git",
    "cd octo-neo",
    "pnpm install",
    "pnpm tauri dev      # run the app with hot reload",
    "pnpm tauri build    # build the installer for this platform",
  ],
  { title: "Terminal" },
)}
<p>To work on the interface alone, ${code("pnpm dev")} runs it in a browser against a built-in mock of the core: a fictional account and a fictional model, nothing real.</p>
<h3>Builds on macOS and the keychain</h3>
<p>A build made on your Mac is sealed with an ad-hoc signature that is different for every build. macOS ties keychain access to it, so each new build asks again whether it may read the keys an earlier build stored. To keep one identity across builds, sign with a certificate you already have, for example an Apple Development certificate:</p>
${shell(
  [
    "security find-identity -v -p codesigning     # the identities you can sign with",
    'APPLE_SIGNING_IDENTITY="Apple Development: you@example.com (TEAMID)" pnpm tauri build --bundles app',
  ],
  { title: "Terminal" },
)}`,
        },
        {
          id: "first-launch",
          title: "The first launch of a downloaded copy",
          lead: "macOS and Windows warn you before the first launch of a downloaded copy. The repository holds no certificates, so the installers are not signed with a developer certificate or notarized, and macOS builds carry an ad-hoc signature only.",
          body: `<div class="launch-steps">
<div class="launch">
<h3>macOS</h3>
${steps([
  "macOS will not open the app the first time, because it cannot verify it.",
  "Open System Settings, then Privacy &amp; Security.",
  "Choose Open Anyway beside the message about OctoNeo.",
  "macOS asks you to confirm once more. After that, the app opens normally.",
])}
</div>
<div class="launch">
<h3>Windows</h3>
${steps([
  "Microsoft Defender SmartScreen may say that Windows protected your PC.",
  "Choose More info.",
  "Choose Run anyway.",
])}
</div>
</div>
<p>Do this only for a copy you downloaded from the project’s ${out(RELEASES, "Releases page")}, or one you built yourself.</p>`,
        },
        {
          id: "start",
          title: "After you install",
          lead: "The app opens on mainnet prices. Market data needs no wallet, no account and no model.",
          body: `<ol class="steps-list">
<li><strong><a href="/models/">Connect a model.</a></strong> The first launch asks for one.</li>
<li><strong>Ask “BTC outlook”.</strong> The answer comes with the readings it is based on.</li>
<li><strong><a href="/wallet/">Connect a wallet.</a></strong> Deposit before the first trade: the exchange serves an account only after its first deposit. To trade with test funds, switch to Testnet at the top.</li>
<li><strong>Ask “Long 0.01 BTC”.</strong> The assistant picks a stop-loss, says where it put it, and drafts a ticket. Review it, then place the order. Ask “Close my BTC” to exit.</li>
</ol>
${facts([
  ["Message box", `${code("Ctrl+K")} on Windows and Linux, ${code("Cmd+K")} on macOS`],
  ["Settings", `${code("Ctrl+,")} on Windows and Linux, ${code("Cmd+,")} on macOS`],
  ["Stop an answer", code("Esc")],
])}`,
        },
        {
          id: "upgrade",
          title: "Upgrading from Octo Gens 0.4",
          body: `<ul class="checks">
<li>The app installs as OctoNeo, beside any Octo Gens you have. Quit and remove the old app; the new one picks up its wallet, settings and conversations as they are.</li>
<li>Your OpenRouter key and model carry over. If you had chosen the built-in agents, connect a model at the first launch: every message is now answered by a model.</li>
<li>An Ollama model chosen in 0.4 stays selected. If it cannot use tools, the first answer says so; pick one that can in Settings.</li>
<li>Earlier conversations appear in the sidebar.</li>
</ul>`,
        },
        {
          id: "updates",
          title: "Updates and help",
          body: `<p>OctoNeo checks GitHub for a newer release when it starts. When one is out, a note in the sidebar and Settings, About &amp; Updates show its release notes and link to the download, and you can skip a version you do not want. Fixes are released for the latest version only, so keep the app up to date. The ${out(doc("CHANGELOG.md"), "changelog")} lists what changed in each version. To report a bug or suggest an idea, open an ${out(ISSUES, "issue on GitHub")}; to report a security problem, follow the ${out(doc("SECURITY.md"), "security policy")} instead.</p>
<p>The source is at ${out(REPO, "github.com/kerjakuyco/octo-neo")}.</p>`,
        },
      ],
    }),
};
