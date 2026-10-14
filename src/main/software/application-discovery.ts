import { utilityProcess } from "electron";
import { join } from "node:path";
import { z } from "zod";
import { scopeAliasSchema } from "../../shared/files";

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
type Candidate = z.infer<typeof candidatesSchema>[number];
let pending: Promise<Candidate[]> | null = null;

/** A fixed, bundled utility process inspects inventory; it never launches a discovered program. */
export function discoverApplications(): Promise<Candidate[]> {
  if (pending) return pending;
  pending = new Promise<Candidate[]>((resolve, reject) => {
    const child = utilityProcess.fork(
      join(__dirname, "application-discovery-worker.js"),
      [],
      { serviceName: "Verbo application discovery", stdio: "ignore" },
    );
    let settled = false;
    const finish = (
      error: Error | null,
      candidates: Candidate[] = [],
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(candidates);
    };
    const timer = setTimeout(
      () => finish(new Error("Application detection timed out. Try again.")),
      15000,
    );
    child.on("message", (message: unknown) => {
      const reply = z
        .object({ ok: z.literal(true), candidates: candidatesSchema })
        .strict()
        .safeParse(message);
      if (!reply.success) {
        finish(new Error("Application detection could not complete."));
        return;
      }
      finish(null, reply.data.candidates);
    });
    child.once("exit", () =>
      finish(
        new Error("Application detection stopped before returning results."),
      ),
    );
  }).finally(() => {
    pending = null;
  });
  return pending;
}
