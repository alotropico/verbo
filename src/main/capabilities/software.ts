import type { ActionResult } from "../../shared/action-contract";
import { boundedDetail } from "../../shared/bounded-detail";
import {
  softwareFindArgsSchema,
  softwareListArgsSchema,
} from "../../shared/software";
import {
  findSoftware,
  listSoftwarePage,
  windowsSoftwareSource,
  type SoftwareSource,
} from "../software/inventory";
import type { Capability } from "./registry";

function failure(action: string, code: string, summary: string): ActionResult {
  return {
    action,
    status: code === "unsupported_platform" ? "not_supported" : "error",
    code,
    summary,
  };
}

export function softwareCapabilities(
  source: SoftwareSource = windowsSoftwareSource(),
): Capability[] {
  return [
    {
      id: "software.list",
      description:
        "Paginated Windows installed-program inventory. Does not launch programs or return uninstall commands.",
      kind: "read",
      approval: "none",
      args: softwareListArgsSchema,
      example: {},
      execute(args): ActionResult {
        const page = listSoftwarePage({
          source,
          pageSize: Number(args.pageSize ?? 20),
          ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        });
        if (!page.ok) return failure("software.list", page.code, page.summary);
        const packed = boundedDetail({
          offset: page.offset,
          total: page.total,
          complete: page.complete,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          programs: page.programs,
        });
        const status = page.complete ? "success" : "partial";
        const shown = page.programs.length;
        return {
          action: "software.list",
          status,
          ...(page.complete ? {} : { code: "limit_reached" }),
          summary:
            page.total === 0
              ? "No installed programs were found."
              : `Installed programs ${page.offset + 1}-${page.offset + shown} of ${page.total}.`,
          detail: packed.detail,
          totalItems: page.total,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
    {
      id: "software.find",
      description:
        "Find one Windows program by name in uninstall metadata, PATH, and known folders. Does not launch it.",
      kind: "read",
      approval: "none",
      args: softwareFindArgsSchema,
      example: { name: "notepad" },
      execute(args): ActionResult {
        const found = findSoftware({ source, name: String(args.name) });
        if (!found.ok)
          return failure("software.find", found.code, found.summary);
        if (found.matches.length === 0) {
          return failure(
            "software.find",
            "not_found",
            `No installed program matches ${found.token}.`,
          );
        }
        const packed = boundedDetail({
          name: found.token,
          matches: found.matches,
        });
        return {
          action: "software.find",
          status: "success",
          summary: `${found.matches.length} matches for ${found.token}. Nothing was launched.`,
          detail: packed.detail,
          ...(packed.detailsAvailable ? { detailsAvailable: true } : {}),
        };
      },
    },
  ];
}
