import { z } from "zod";

const sourceId = z.string().regex(/^web:[a-f0-9]{64}$/);
const url = z
  .string()
  .url()
  .max(2048)
  .refine((value) => {
    const parsed = new URL(value);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  });
const source = z.object({ sourceId, url, title: z.string().max(300) });
export type WebSourceReference = z.infer<typeof source> & {
  kind: "lead" | "page";
};
export function webSourcesFromResult(result: unknown): WebSourceReference[] {
  const envelope = z
    .object({
      action: z.enum(["web.search", "web.read"]),
      status: z.literal("success"),
      data: z.unknown(),
    })
    .safeParse(result);
  if (!envelope.success) return [];
  if (envelope.data.action === "web.search") {
    const data = z
      .object({ results: z.array(source).max(10) })
      .safeParse(envelope.data.data);
    return data.success
      ? data.data.results.map((entry) => ({ ...entry, kind: "lead" }))
      : [];
  }
  const data = z
    .object({ sourceId, finalUrl: url, title: z.string().max(300).optional() })
    .safeParse(envelope.data.data);
  return data.success
    ? [
        {
          sourceId: data.data.sourceId,
          url: data.data.finalUrl,
          title: data.data.title ?? data.data.finalUrl,
          kind: "page",
        },
      ]
    : [];
}
