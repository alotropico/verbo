import { describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryAddArgsSchema, memoryListArgsSchema } from "@shared/memory";
import { commandParameterDetails } from "./command-parameter-details";

describe("command parameter details", () => {
  it("keeps null, boolean and numeric choices in readable enum summaries", () => {
    expect(
      commandParameterDetails({
        properties: { value: { enum: [null, false, 0, "auto"] } },
      })[0].choices,
    ).toEqual(["null", "false", "0", "auto"]);
  });
  it("presents memory list choices and validation limits without requiring optional filters", () => {
    const parameters = commandParameterDetails(
      z.toJSONSchema(memoryListArgsSchema),
    );
    expect(
      parameters.find((parameter) => parameter.name === "scope"),
    ).toMatchObject({ required: false, choices: ["global", "thread"] });
    expect(
      parameters.find((parameter) => parameter.name === "threadId")?.limits,
    ).toEqual(["1–128 characters"]);
    expect(
      parameters.find((parameter) => parameter.name === "limit"),
    ).toMatchObject({ type: "Integer", limits: ["1–40"] });
    expect(parameters.every((parameter) => !parameter.required)).toBe(true);
  });

  it("treats defaulted arguments as optional even when the output JSON schema requires them", () => {
    const parameters = commandParameterDetails(
      z.toJSONSchema(memoryAddArgsSchema),
    );
    expect(
      parameters.find((parameter) => parameter.name === "text")?.required,
    ).toBe(true);
    expect(
      parameters.find((parameter) => parameter.name === "scope"),
    ).toMatchObject({ required: false, defaultValue: "global" });
    expect(
      parameters.find((parameter) => parameter.name === "inclusion"),
    ).toMatchObject({ required: false, defaultValue: "on_demand" });
  });

  it("retains supplied help when an argument schema is absent and handles opaque schemas", () => {
    expect(
      commandParameterDetails(null, { query: "Search saved memories." })[0],
    ).toMatchObject({ name: "query", description: "Search saved memories." });
    expect(commandParameterDetails({ anyOf: [{ type: "object" }] })).toEqual(
      [],
    );
    expect(commandParameterDetails(false)).toEqual([]);
  });
});
