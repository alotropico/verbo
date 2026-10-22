import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MantineProvider } from "@mantine/core";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSettings as SavedWebSettings } from "@shared/web-settings";
import { SettingsSession } from "../runtime/settings-session";
import { SettingsSessionContext } from "../hooks/settings-session-context";
import { WebSettings } from "./WebSettings";

const controls = vi.hoisted(() => new Map<string, { value: number; onChange: (value: number) => void }>());
vi.mock("./SettingsSlider", () => ({
  SettingsSlider: (props: { label: string; value: number; onChange: (value: number) => void }) => {
    controls.set(props.label, props);
    return null;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  controls.clear();
});

it("loads the saved draft before editing and preserves it across remounts", async () => {
  const saved: SavedWebSettings = {
    engines: ["google", "wikipedia"],
    pageSize: 2,
    maxSnippetChars: 420,
    timeoutMs: 12000,
  };
  const api = { settings: vi.fn(async () => saved), setSettings: vi.fn(async (next: SavedWebSettings) => next) };
  const session = new SettingsSession();
  const render = (): string =>
    renderToStaticMarkup(
      createElement(MantineProvider, {}, createElement(SettingsSessionContext, { value: session }, createElement(WebSettings))),
    );

  expect(render()).toContain("Loading web search settings");
  expect(controls.size).toBe(0);
  vi.stubGlobal("window", { verbo: { web: api } });
  await session.resource("web/settings", api.settings).load();
  vi.unstubAllGlobals();
  const markup = render();
  expect(markup).toContain("Enable Google");
  expect(controls.get("Page size")?.value).toBe(2);
  expect(controls.get("Maximum snippet length")?.value).toBe(420);
  controls.get("Page size")?.onChange(3);

  // A remount receives the cached server resource but retains the pending edit.
  render();
  expect(controls.get("Page size")?.value).toBe(3);
  vi.stubGlobal("window", { verbo: { web: api } });
  await session.flush();
  expect(api.setSettings).toHaveBeenCalledExactlyOnceWith({ ...saved, pageSize: 3 });
});
