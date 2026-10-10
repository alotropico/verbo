import { describe, expect, it } from "vitest";
import { modelRoute, parseLocalCommand } from "./local-commands";
import { formatEstimatedTokens, meterLevel } from "./memory";

describe("local commands", () => {
  it("keeps slash commands off the model route", () => {
    expect(modelRoute("/remember Prefers short replies")).toBe("local");
    expect(modelRoute("/nope")).toBe("local");
    expect(modelRoute("please /remember this")).toBe("model");
    expect(parseLocalCommand("/remember")).toMatchObject({
      name: "malformed",
      summary: "/remember needs the text to save.",
    });
    expect(parseLocalCommand("/forget")).toMatchObject({
      name: "malformed",
    });
    expect(parseLocalCommand("/memories")).toEqual({
      handled: true,
      name: "memories",
    });
  });
});

describe("context meters", () => {
  it("labels estimated thresholds without claiming exact tokens", () => {
    expect(meterLevel(69, 100)).toBe("ok");
    expect(meterLevel(70, 100)).toBe("warn");
    expect(meterLevel(90, 100)).toBe("warn");
    expect(meterLevel(91, 100)).toBe("high");
    expect(formatEstimatedTokens(512)).toBe("512");
    expect(formatEstimatedTokens(8192)).toBe("8.2k");
  });
});
