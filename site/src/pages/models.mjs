import { chip, code, doc, docPage, facts, icon, out, table, ui, uiButton } from "../site.mjs";

/** How each provider is handled: one row per difference, one column per provider. */
const PROVIDERS = ["OpenRouter", "Cloudflare AI Gateway", "LM Studio", "Ollama"];
const DIFFERENCES = [
  ["Request format", ["Chat Completions", "Chat Completions", "Chat Completions", "Ollama’s own chat API"]],
  [code("temperature"), ["Sent when the catalog lists it", "Not sent: the models behind a gateway disagree on it", "Sent", "Sent"]],
  ["Output cap", ["Sent, never above the model’s own", "Sent to Cloudflare’s own models only", "Sent", `Sent as ${code("num_predict")}, with the context size`]],
  ["Reasoning effort", ["Sent to models that support it", "Not sent", "Not sent", "Not sent"]],
  ["Thinking handed back with tool results", ["Yes", "No", "No", "Yes"]],
  ["Usage shown", ["Tokens and cost", "Tokens", "Tokens", "Tokens"]],
];

/**
 * The comparison as a table with a column per provider, and the same table turned around, with a
 * block per provider, which is the one a phone shows: five columns do not fit there.
 */
const comparison = () => `<div class="table-along">
${table({
  head: ["What differs", ...PROVIDERS],
  className: "compact",
  rows: DIFFERENCES.map(([what, values]) => [what, ...values]),
})}
</div>
<div class="table-across">
${table({
  head: ["Provider", ...DIFFERENCES.map(([what]) => what)],
  stack: true,
  rows: PROVIDERS.map((provider, column) => [provider, ...DIFFERENCES.map(([, values]) => values[column])]),
})}
</div>`;

/**
 * The head's picture: Settings open on Models, as the app's built-in mock shows it: the sections in
 * their three groups down the side, the model in use, then the providers in the cloud and on this
 * computer. Lantern 2 Large and reef:8b are the mock's fictional models; the mock's model supports
 * reasoning, whose effort is sent only to the OpenRouter models that do (the comparison below).
 */
const provider = (name, detail, buttons, state = "") =>
  `<li class="ui-row"><div class="ui-row-text"><p class="ui-row-title">${name}${state}</p><p class="ui-row-detail">${detail}</p></div><div class="ui-row-actions">${buttons.join("")}</div></li>`;

/** The sections of Settings, in the app's groups: [group, [[icon, name, open]]]. */
const SECTIONS = [
  ["Assistant", [["model", "Models", true], ["plug", "Tools"]]],
  ["Exchange", [["wallet", "Wallets"], ["trade", "Risk &amp; Trading"]]],
  ["App", [["appearance", "General"], ["info", "About &amp; Updates"]]],
];

const SETTINGS = ui({
  className: "ui-settings",
  label:
    "A sample of Settings in OctoNeo, open on Models. Down the side, its sections in three groups: Assistant, with Models and Tools; Exchange, with Wallets and Risk & Trading; and App, with General and About & Updates. The active model is the fictional Lantern 2 Large, from OpenRouter, with reasoning. Under Cloud providers, OpenRouter is active and Cloudflare AI Gateway is not connected; under Local servers, Ollama is ready with the fictional local model reef:8b, and LM Studio is not connected.",
  caption: "Settings, Models, drawn from the app’s built-in mock: Lantern 2 Large and reef:8b are fictional models.",
  body: `<div class="ui-settings-body">
<div class="ui-side">
<p class="ui-side-title">Settings</p>
${SECTIONS.map(
  ([group, items]) => `<p class="ui-side-group">${group}</p>
<ul>${items.map(([glyph, name, on]) => `<li${on ? " data-on" : ""}>${icon(glyph, 16)}${name}</li>`).join("")}</ul>`,
).join("\n")}
</div>
<div class="ui-settings-main">
<div class="ui-settings-head">
<div><p class="ui-settings-title">Models</p><p class="ui-settings-desc">Connect cloud or local AI providers and tune reasoning depth.</p></div>
<span class="ui-bar-end">${chip("Sample")}<span class="ui-close">${icon("close", 18)}</span></span>
</div>
<div class="ui-settings-panel">
<div class="ui-active">
<div><p class="ui-active-label">Active model</p><p class="ui-active-value"><span class="ui-dot" data-tone="up"></span><strong>Lantern 2 Large</strong>${chip("OpenRouter")}${chip("Reasoning")}</p></div>
${uiButton("Switch model", "outline")}
</div>
<p class="ui-group-head">Cloud providers</p>
<ul class="ui-rows">
${provider("OpenRouter", "Lantern 2 Large", [uiButton("Change", "outline"), uiButton("Disconnect", "ghost")], chip("Active", "up"))}
${provider("Cloudflare AI Gateway", "Cloud", [uiButton("Connect", "outline")])}
</ul>
<p class="ui-group-head">Local servers</p>
<ul class="ui-rows">
${provider("Ollama", "reef:8b", [uiButton("Use", "outline"), uiButton("Change", "outline"), uiButton("Disconnect", "ghost")], chip("Ready"))}
${provider("LM Studio", "On this computer", [uiButton("Connect", "outline")])}
</ul>
</div>
</div>
</div>`,
});

export default {
  path: "/models/",
  title: "Models | OctoNeo",
  description:
    "Connect OctoNeo to OpenRouter, Cloudflare AI Gateway, Ollama or LM Studio. The model must support tool calls, and a model on your computer keeps your conversations there.",
  render: () =>
    docPage({
      path: "/models/",
      title: "Bring your own model",
      lead: "Every message is answered by a language model, so OctoNeo needs one. Connect a model in the cloud, or run one on your own computer and keep your conversations there. The first launch asks you to choose.",
      visual: SETTINGS,
      sections: [
        {
          id: "providers",
          title: "Four providers",
          body: `${table({
            head: ["Provider", "Where the model runs", "What you give the app"],
            stack: true,
            rows: [
              ["OpenRouter", "In the cloud, on any model OpenRouter offers", `An ${out("https://openrouter.ai/keys", "OpenRouter key")}. Pick any model that supports tools; the list shows its context size and price. OpenRouter bills you for what the model uses.`],
              ["Cloudflare AI Gateway", "In the cloud, on a model from the provider you name, or one of Cloudflare’s own", `Your Cloudflare account ID, an API token with the <em>Workers AI Read</em> permission, a gateway ID if you use one, and a model such as ${code("openai/gpt-4.1")}. Cloudflare bills your account.`],
              ["Ollama", "On your computer", `${out("https://ollama.com", "Ollama")} running, with a model that supports tools, for example after ${code("ollama pull qwen3:8b")}. The server’s address only if it is not the usual one.`],
              ["LM Studio", "On your computer", `${out("https://lmstudio.ai", "LM Studio")} with its local server started and a model trained for tool use. The app loads the model for you.`],
            ],
          })}
<p>Cloudflare lists only its own Workers AI models. A model from another provider is typed in by its id, such as ${code("openai/gpt-4.1")}, and Cloudflare bills it to your account.</p>`,
        },
        {
          id: "check",
          title: "The model must call tools",
          lead: "The assistant works only through tools: that is how it reads the market and drafts tickets. So a model is checked before it is kept, and a model that cannot call tools is refused, whichever provider it comes from. If the check fails, nothing is stored.",
          body: table({
            head: ["Provider", "The check"],
            stack: true,
            rows: [
              ["OpenRouter", "A new key is shown to OpenRouter. The model must be in the catalog and listed as supporting tools."],
              ["Cloudflare AI Gateway", "One short chat that asks the model to call a tool. It proves the account, the token, the gateway and the model together, and that a tool call really comes back. A model that answers in words is refused."],
              ["Ollama", "The model must be installed on this computer, not a cloud alias, and able to use tools."],
              ["LM Studio", "The model must be installed and trained for tool use. It is loaded with a context of 16,384 tokens if it is not loaded yet; a model already loaded with less than 8,192 is refused, with a note to reload it."],
            ],
          }),
        },
        {
          id: "local",
          title: "In the cloud or on your computer",
          body: `<p>With a cloud model, your messages and what the assistant reads for them, including the account summary in each message, go to that provider: OpenRouter, or Cloudflare and the provider behind your gateway. With Ollama or LM Studio they stay on your computer, and the only requests that leave it go to the exchange, to any tool server you attached and, while web search is on, to news publishers, the articles the assistant opens from news results and pages you link.</p>
<p>A model on your computer works in a smaller context than a cloud model, so the app hands it less. Pick the largest one your machine runs comfortably.</p>
${table({
  head: ["Handed to the model", "Cloud model", "Model on your computer"],
  stack: true,
  numeric: [1, 2],
  rows: [
    ["Earlier turns replayed", "6", "3"],
    ["Characters of each earlier answer", "2,000", "1,200"],
    ["Largest tool result", "12,000 bytes", "6,000 bytes"],
    ["Headlines from one news search", "8", "6"],
    ["Text of a web page", "8,000 bytes", "3,500 bytes"],
    ["Output budget per round", "4,096 tokens", "3,072 tokens"],
  ],
})}
<p>Requests to a model on your computer never go through a system proxy and are never redirected. The address is yours to choose: if you point Ollama or LM Studio at another machine, your conversations go to that machine.</p>`,
        },
        {
          id: "providers-compared",
          title: "How each provider is handled",
          lead: "The same agent loop drives every provider. What differs is how a request is written.",
          body: `${comparison()}
<ul class="checks">
<li>A reply that spent its whole output budget on thinking is reported as such, with a suggestion.</li>
<li>A server on your computer that is not running is said plainly, with what to start.</li>
<li>A reply is read under a watch: a server that stalls, or sends more than a reply could be, ends the turn with an explanation instead of holding it, and Stop always works.</li>
</ul>`,
        },
        {
          id: "keys",
          title: "Keys",
          body: `${facts([
            ["Where they live", "The OpenRouter key and the Cloudflare API token are kept in your system keychain, never in preferences or the journal."],
            ["Where they never go", "Into prompts, answers, errors, traces or the journal. Answers and errors are scrubbed of the provider’s key before they are shown or stored."],
            ["Checked first", "A new OpenRouter key is shown to OpenRouter, and a Cloudflare token is proved with one short chat, before either is kept. A key that is turned away replaces nothing."],
            ["Least privilege", "Give a Cloudflare API token only the Workers AI Read permission. The app needs nothing more."],
          ], "facts-wide")}
<p>More detail, including the rounds of a turn, is in ${out(doc("docs/assistant.md", "model-compatibility"), "docs/assistant.md")}.</p>`,
        },
      ],
    }),
};
