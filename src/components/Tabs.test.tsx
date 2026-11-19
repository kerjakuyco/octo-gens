import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "./Tabs";

describe("tabs", () => {
  it("draws an icon before the label only where one is given", () => {
    const html = renderToStaticMarkup(
      <Tabs
        vertical
        label="Settings"
        value="models"
        options={[
          { value: "models", label: "Models", icon: "model" },
          { value: "about", label: "About" },
        ]}
        onChange={() => {}}
        panelId="panel"
      />,
    );
    const [models, about] = html.split("</button>");
    expect(models).toMatch(/aria-selected="true"[^>]*><svg[^>]*aria-hidden="true"[^>]*>.*<\/svg>Models$/);
    expect(about).toMatch(/aria-selected="false"[^>]*>About$/);
    expect(about).not.toContain("<svg");
    expect(html).toContain('aria-orientation="vertical"');
  });
});
