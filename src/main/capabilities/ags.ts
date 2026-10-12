import type { DatabaseSync } from "node:sqlite";
import type { ActionResult } from "../../shared/action-contract";
import { boundedDetail } from "../../shared/bounded-detail";
import { agsHostArgsSchema, agsHostsArgsSchema } from "../../shared/ags";
import { readAgsCheck } from "../db/ags-check";
import { createRootStore } from "../db/registered-roots";
import type { ScopeStore } from "../db/scopes";
import { runAgsCheck, type AgsCommandRunner } from "../ags/check";
import { readAgsMetadata } from "../ags/metadata";
import { resolveRegisteredRoot } from "../projects/resolve-root";
import type { ActionContext, Capability } from "./registry";

function failure(
  action: string,
  code: string,
  summary: string,
  status: ActionResult["status"] = "error",
): ActionResult {
  return { action, status, code, summary };
}

export function agsCapabilities(
  resolveDatabase?: () => DatabaseSync,
  resolveScopes?: () => ScopeStore,
  runner?: AgsCommandRunner,
): Capability[] {
  function database(action: string): DatabaseSync | ActionResult {
    try {
      if (!resolveDatabase) {
        return failure(action, "unavailable", "AGS is not configured.");
      }
      return resolveDatabase();
    } catch {
      return failure(action, "unavailable", "AGS is not configured.");
    }
  }

  return [
    {
      id: "ags.hosts",
      description:
        "Registered AGS hosts. A repository is not an AGS host unless it was registered.",
      kind: "read",
      approval: "none",
      args: agsHostsArgsSchema,
      example: {},
      execute(): ActionResult {
        const opened = database("ags.hosts");
        if ("status" in opened) return opened;
        const hosts = createRootStore(opened, "ags_hosts", "AGS host")
          .list()
          .slice(0, 20)
          .map((host) => ({ alias: host.alias, path: host.path }));
        const check = readAgsCheck(opened);
        const packed = boundedDetail({
          hosts,
          checkConfigured: check.configured,
        });
        return {
          action: "ags.hosts",
          status: "success",
          summary:
            hosts.length === 0
              ? "No AGS hosts are registered."
              : `${hosts.length} registered AGS hosts.`,
          detail: packed.detail,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
    {
      id: "ags.inspect",
      description:
        "Versioned AGS metadata for one registered host. Does not run repository instructions.",
      kind: "read",
      approval: "none",
      args: agsHostArgsSchema,
      example: { host: "verbo" },
      execute(args, context: ActionContext): ActionResult {
        const opened = database("ags.inspect");
        if ("status" in opened) return opened;
        const scopes = resolveScopes?.();
        const resolved = resolveRegisteredRoot({
          reference: String(args.host),
          roots: createRootStore(opened, "ags_hosts", "AGS host").list(),
          grants: scopes?.activeGrants() ?? [],
          noun: "AGS host",
          actor: context.actor,
        });
        if (!resolved.ok) {
          return failure("ags.inspect", resolved.code, resolved.summary);
        }
        const metadata = readAgsMetadata(resolved.root.path);
        if (!metadata) {
          return failure(
            "ags.inspect",
            "not_supported",
            "That host has no readable .agents/ags.yaml metadata.",
            "not_supported",
          );
        }
        const packed = boundedDetail({
          alias: resolved.root.alias,
          path: resolved.root.path,
          format: metadata.format,
          host: metadata.host,
          agsVersion: metadata.agsVersion,
        });
        return {
          action: "ags.inspect",
          status: "success",
          summary: `AGS ${metadata.agsVersion || "metadata"} at ${resolved.root.alias}.`,
          detail: packed.detail,
        };
      },
    },
    {
      id: "ags.check",
      description:
        "Run the fixed ags check command on a registered host. No caller-supplied command or arguments.",
      kind: "read",
      approval: "none",
      args: agsHostArgsSchema,
      example: { host: "verbo" },
      execute(args, context): ActionResult {
        const opened = database("ags.check");
        if ("status" in opened) return opened;
        const check = readAgsCheck(opened);
        if (!check.configured || !check.path) {
          return failure(
            "ags.check",
            "not_supported",
            "No allowlisted ags executable is configured.",
            "not_supported",
          );
        }
        const scopes = resolveScopes?.();
        const resolved = resolveRegisteredRoot({
          reference: String(args.host),
          roots: createRootStore(opened, "ags_hosts", "AGS host").list(),
          grants: scopes?.activeGrants() ?? [],
          noun: "AGS host",
          actor: context.actor,
        });
        if (!resolved.ok) {
          return failure("ags.check", resolved.code, resolved.summary);
        }
        const ran = runAgsCheck({
          executable: check.path,
          cwd: resolved.root.path,
          ...(runner ? { runner } : {}),
        });
        const packed = boundedDetail({
          host: resolved.root.alias,
          args: ran.args,
          exitCode: ran.result.code,
          timedOut: ran.result.timedOut,
          stdout: ran.result.stdout,
          stderr: ran.result.stderr,
          artifacts: ran.artifacts,
        });
        if (ran.result.timedOut) {
          return {
            action: "ags.check",
            status: "error",
            code: "timeout",
            summary: "The AGS check timed out.",
            detail: packed.detail,
          };
        }
        if (ran.result.code !== 0) {
          return {
            action: "ags.check",
            status: "error",
            code: "check_failed",
            summary: `AGS check exited ${ran.result.code}.`,
            detail: packed.detail,
          };
        }
        return {
          action: "ags.check",
          status: "success",
          summary: "AGS check finished.",
          detail: packed.detail,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
  ];
}
