type ParameterDetails = {
  name: string;
  required: boolean;
  description?: string;
  type?: string;
  defaultValue?: string;
  choices: string[];
  limits: string[];
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parameterType(schema: Record<string, unknown>): string | undefined {
  const labels: Record<string, string> = {
    string: "Text",
    integer: "Integer",
    number: "Number",
    boolean: "True / false",
    array: "List",
    object: "Object",
    null: "Null",
  };
  if (typeof schema.type === "string")
    return labels[schema.type] ?? schema.type;
  if (Array.isArray(schema.type))
    return schema.type
      .filter((type): type is string => typeof type === "string")
      .map((type) => labels[type] ?? type)
      .join(" or ");
  return undefined;
}

export function commandParameterDetails(
  args: unknown,
  help: Record<string, string> = {},
): ParameterDetails[] {
  const schema = record(args);
  const properties = record(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required : [];
  return [...new Set([...Object.keys(properties), ...Object.keys(help)])].map(
    (name) => {
      const property = record(properties[name]);
      const limits: string[] = [];
      for (const [minKey, maxKey, unit] of [
        ["minLength", "maxLength", "characters"],
        ["minItems", "maxItems", "items"],
        ["minimum", "maximum", ""],
      ]) {
        const minimum = property[minKey];
        const maximum = property[maxKey];
        if (typeof minimum === "number" && typeof maximum === "number")
          limits.push(`${minimum}–${maximum}${unit ? ` ${unit}` : ""}`);
        else if (typeof maximum === "number")
          limits.push(`Up to ${maximum}${unit ? ` ${unit}` : ""}`);
        else if (typeof minimum === "number")
          limits.push(`At least ${minimum}${unit ? ` ${unit}` : ""}`);
      }
      return {
        name,
        required:
          required.includes(name) && !Object.hasOwn(property, "default"),
        description:
          help[name] ||
          (typeof property.description === "string"
            ? property.description
            : undefined),
        type: parameterType(property),
        defaultValue: Object.hasOwn(property, "default")
          ? typeof property.default === "string"
            ? property.default
            : JSON.stringify(property.default)
          : undefined,
        choices: Array.isArray(property.enum)
          ? property.enum
              .filter(
                (value) =>
                  value === null ||
                  ["string", "number", "boolean"].includes(typeof value),
              )
              .map(String)
          : [],
        limits,
      };
    },
  );
}
