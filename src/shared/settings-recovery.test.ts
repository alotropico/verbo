import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_SETTINGS } from "./config";
import {
  contextChoices,
  legacyTemperatureNotice,
  recoverSettings,
  sliderTemperature,
} from "./settings-recovery";

describe("settings recovery", () => {
  it("keeps a valid file, including temperature above 1 and a non-preset context", () => {
    const recovered = recoverSettings({
      model: "custom:tag",
      think: false,
      temperature: 1.4,
      numCtx: 6000,
      keepAlive: "10m",
    });
    expect(recovered.issues).toEqual([]);
    expect(recovered.settings).toMatchObject({
      model: "custom:tag",
      think: false,
      temperature: 1.4,
      numCtx: 6000,
      keepAlive: "10m",
    });
    expect(legacyTemperatureNotice(1.4)).toContain("1.4");
    expect(sliderTemperature(1.4)).toBe(1);
    expect(contextChoices(6000)[0]).toEqual({
      value: "6000",
      label: "6000 (saved)",
    });
  });

  it("replaces only the invalid field", () => {
    const recovered = recoverSettings({
      model: "custom:tag",
      think: true,
      temperature: 3,
      numCtx: 8192,
      keepAlive: "5m",
    });
    expect(recovered.settings.model).toBe("custom:tag");
    expect(recovered.settings.temperature).toBe(
      DEFAULT_CHAT_SETTINGS.temperature,
    );
    expect(recovered.settings.numCtx).toBe(8192);
    expect(recovered.issues.length).toBeGreaterThan(0);
  });
});
