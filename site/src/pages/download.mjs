import { REPO, RELEASES, ISSUES, VERSION, code, doc, docPage, facts, out, shell } from "../site.mjs";

export default {
  path: "/download/",
  title: "Get OctoNeo",
  description:
    "OctoNeo 0.5.0 for Windows, macOS and Linux. No installer has been published yet: build it from source with a few commands, then practice on testnet.",
  render: (ctx) =>
    docPage({
      path: "/download/",
      title: "Get OctoNeo",
      lead: `Version ${VERSION} for Windows, macOS and Linux. Installers will be attached to each release on GitHub. None has been published yet, so for now you build it from source.`,
      picture: `<div class="release">
  <img class="release-icon" src="${ctx.asset("images/icon.svg")}" width="88" height="88" alt="">
  <div class="release-body">
    ${facts([
      ["Version", VERSION],
      ["Platforms", "Windows, macOS, Linux"],
      ["License", "GPL-3.0-only"],
      ["Installers", "None published yet"],
    ], "release-facts")}
    <div class="actions">
      <a class="button button-brand" href="#build">Build from source</a>
      <a class="button button-quiet" href="${RELEASES}">Open the Releases page</a>
    </div>
  </div>
</div>`,
      sections: [
        {
          id: "build",
          title: "Build from source",
          lead: "You need four things, and no wallet or model key to build or to run the tests.",
          body: `${facts([
            ["Rust", `The stable toolchain, from ${out("https://rustup.rs", "rustup.rs")}`],
            ["Node.js", `Version 20 or newer, from ${out("https://nodejs.org", "nodejs.org")}`],
            ["pnpm", `Version 10, from ${out("https://pnpm.io", "pnpm.io")}`],
            ["Tauri’s system dependencies", `For your platform, as listed in ${out("https://tauri.app/start/prerequisites/", "Tauri’s prerequisites")}`],
          ], "facts-wide")}
${shell([
  "git clone https://github.com/kerjakuyco/octo-neo.git",
  "cd octo-neo",
  "pnpm install",
  "pnpm tauri dev      # run the app with hot reload",
  "pnpm tauri build    # build the installer for this platform",
])}
<p>To work on the interface alone, ${code("pnpm dev")} runs it in a browser against a built-in mock of the core: a fictional account and a fictional model, nothing real.</p>
<h3>Builds on macOS and the keychain</h3>
<p>A build made on your Mac is sealed with an ad-hoc signature that is different for every build. macOS ties keychain access to it, so each new build asks again whether it may read the keys an earlier build stored. To keep one identity across builds, sign with a certificate you already have, for example an Apple Development certificate:</p>
${shell([
  "security find-identity -v -p codesigning     # the identities you can sign with",
  'APPLE_SIGNING_IDENTITY="Apple Development: you@example.com (TEAMID)" pnpm tauri build --bundles app',
])}`,
        },
        {
          id: "first-launch",
          title: "The first launch of a downloaded copy",
          lead: "When installers are published, macOS and Windows will warn you before the first launch of a downloaded copy. The repository holds no certificates, so installers are not signed with a developer certificate or notarized, and macOS builds carry an ad-hoc signature only.",
          body: `${facts([
            ["macOS", "macOS will not open the app the first time, because it cannot verify it. Open System Settings, then Privacy &amp; Security, and choose Open Anyway beside the message about OctoNeo. macOS asks you to confirm once more; after that the app opens normally."],
            ["Windows", "Microsoft Defender SmartScreen may say that Windows protected your PC. Choose More info, then Run anyway."],
          ], "facts-wide")}
<p>Do this only for a copy you downloaded from the project’s ${out(RELEASES, "Releases page")}, or one you built yourself.</p>`,
        },
        {
          id: "start",
          title: "After you install",
          lead: "The app opens on mainnet prices. Market data needs no wallet, no account and no model.",
          body: `<ol class="steps-list">
<li><strong><a href="/models/">Connect a model.</a></strong> The first launch asks for one.</li>
<li><strong>Ask “BTC outlook”.</strong> The answer comes with the readings it is based on.</li>
<li><strong>Switch to Testnet</strong> at the top, and <a href="/wallet/">connect a wallet</a>. Deposit test funds before the first trade: the exchange serves an account only after its first deposit.</li>
<li><strong>Ask “Long 0.01 BTC”.</strong> The assistant picks a stop-loss, says where it put it, and drafts a ticket. Review it, then place the order. Ask “Close my BTC” to exit.</li>
</ol>
${facts([
  ["Message box", `${code("Ctrl+K")} on Windows and Linux, ${code("Cmd+K")} on macOS`],
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
          body: `<p>Fixes are released for the latest version only, so keep the app up to date. The ${out(doc("CHANGELOG.md"), "changelog")} lists what changed in each version. To report a bug or suggest an idea, open an ${out(ISSUES, "issue on GitHub")}; to report a security problem, follow the ${out(doc("SECURITY.md"), "security policy")} instead.</p>
<p>The source is at ${out(REPO, "github.com/kerjakuyco/octo-neo")}.</p>`,
        },
      ],
    }),
};
