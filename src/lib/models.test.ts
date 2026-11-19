import { describe, expect, it } from "vitest";
import type { ProviderView } from "../api/types";
import { isConnected, isNotRunning, modelName, providerPlace, startHint } from "./models";

function provider(patch: Partial<ProviderView>): ProviderView {
  return {
    id: "openrouter",
    name: "OpenRouter",
    local: false,
    hasKey: false,
    model: "",
    label: "",
    account: "",
    gateway: "",
    url: "",
    ...patch,
  };
}

const lmStudio = provider({ id: "lmstudio", name: "LM Studio", local: true });
const ollama = provider({ id: "ollama", name: "Ollama", local: true });

describe("model providers", () => {
  it("says where a provider's models run", () => {
    expect(providerPlace(provider({}))).toBe("Cloud");
    expect(providerPlace(provider({ id: "cloudflare", name: "Cloudflare AI Gateway" }))).toBe("Cloud");
    expect(providerPlace(ollama)).toBe("On this computer");
    expect(providerPlace(lmStudio)).toBe("On this computer");
  });

  it("counts a provider as connected once it has a model, and a key if it needs one", () => {
    expect(isConnected(provider({ model: "lantern/lantern-2-large" }))).toBe(false);
    expect(isConnected(provider({ model: "lantern/lantern-2-large", hasKey: true }))).toBe(true);
    expect(isConnected({ ...ollama, model: "reef:8b" })).toBe(true);
    expect(isConnected(ollama)).toBe(false);
    expect(modelName("lantern/lantern-2-large")).toBe("lantern-2-large");
  });

  it("tells a local server that is not running from any other fault", () => {
    // The core's own words for both servers.
    expect(isNotRunning("LM Studio is not running. Start its local server, then try again.")).toBe(true);
    expect(isNotRunning("Ollama is not running. Start it, then try again.")).toBe(true);
    expect(isNotRunning("Enter the server's address, for example http://127.0.0.1:1234.")).toBe(false);
    expect(isNotRunning("LM Studio (500): Internal Server Error")).toBe(false);
    expect(isNotRunning("")).toBe(false);
  });

  it("says how to start each local server in one line", () => {
    expect(startHint(lmStudio)).toBe("Start the local server in LM Studio, then retry.");
    expect(startHint(ollama)).toBe("Start Ollama, then retry.");
  });
});
