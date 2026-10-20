import { z } from "zod";
import { scopeAliasSchema } from "../../shared/files";
import { aloCall } from "../alo/client";
const candidatesSchema = z
  .array(
    z
      .object({
        name: z.string().min(1).max(300),
        aliases: z.array(scopeAliasSchema).min(1).max(12),
        executable: z.string().min(1).max(1024),
      })
      .strict(),
  )
  .max(256);
export function discoverApplications(): Promise<
  z.infer<typeof candidatesSchema>
> {
  return aloCall(
    {
      method: "settings.applications.discover",
      context: { actor: "ui", threadId: "application-discovery" },
    },
    AbortSignal.timeout(15000),
  ).then((result) => candidatesSchema.parse(result));
}
