import type { AssistantView, Provider, ProviderView } from "../api/types";

/** A provider the assistant can switch to with one click: it has a model, and a key if it needs one. */
export function isConnected(provider: ProviderView): boolean {
  return provider.model !== "" && (provider.local || provider.hasKey);
}

/** A model id without its vendor path: `openai/gpt-4.1` reads `gpt-4.1`. */
export function modelName(id: string): string {
  const name = id.slice(id.lastIndexOf("/") + 1);
  return name || id;
}

/** The name on the model button. */
export function activeModel(assistant: AssistantView): string {
  return assistant.label || modelName(assistant.model);
}

export function providerOf(assistant: AssistantView, id: Provider): ProviderView | undefined {
  return assistant.providers.find((provider) => provider.id === id);
}

/** Where a provider's models run, in the words shown under its name. */
export function providerPlace(provider: ProviderView): string {
  return provider.local ? "On this computer" : "Cloud";
}

/** Whether listing a local server's models failed because nothing answered at its address. */
export function isNotRunning(error: string): boolean {
  return /\bis not running\b/i.test(error);
}

/** What to do about a local server that is not running, in one line. */
export function startHint(provider: ProviderView): string {
  return provider.id === "lmstudio" ? "Start the local server in LM Studio, then retry." : `Start ${provider.name}, then retry.`;
}
