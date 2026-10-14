import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createModuleRegistry } from "../capabilities/modules";
import { dispatchModelTool } from "../capabilities/registry";
import { webBindings, webModule } from "../capabilities/web";
import { createMemoryStore } from "../db/memory";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { executeLocalCommand } from "../runtime/local-command";
import {
  DEFAULT_WEB_SETTINGS,
  searchResultSchema,
} from "../../shared/web-contracts";
import { StdioBrowserClient } from "./browser-client";

describe.skipIf(process.env.VERBO_LIVE_WEB !== "1")(
  "live Web command routes",
  () => {
    it("returns useful organic sources through model dispatch and reads JS content through human dispatch", async () => {
      const browser = new StdioBrowserClient(
        DEFAULT_WEB_SETTINGS,
        resolve("out/main/browser-runtime.js"),
      );
      const database = new DatabaseSync(":memory:");
      try {
        migrateDatabase(database, VERBO_MIGRATIONS);
        const registry = createModuleRegistry([webModule], {
          handlers: webBindings(undefined, browser),
          processes: {},
          aggregators: {},
        });
        const result = await dispatchModelTool(
          registry,
          "actions.invoke",
          {
            name: "online.find",
            args: { query: "Python programming", limit: 3 },
          },
          { actor: "model", threadId: "live-web-fixture" },
        );
        expect(result.status).toBe("success");
        expect(result.action).toBe("web.search");
        const search = z
          .object({
            results: z.array(
              searchResultSchema.extend({
                sourceId: z.string().regex(/^web:/),
              }),
            ),
            attempts: z.array(
              z.object({ engine: z.string(), outcome: z.string() }),
            ),
          })
          .parse(result.data);
        const sources = search.results;
        expect(sources.length).toBeGreaterThan(0);
        expect(
          sources.some((source) =>
            new URL(source.url).hostname.endsWith("python.org"),
          ),
        ).toBe(true);
        console.info("Live search attempts", JSON.stringify(search.attempts));
        const article = await registry.invoke(
          "web.read",
          {
            url: "https://www.typescriptlang.org/docs/handbook/intro.html",
            method: "auto",
            maxChars: 1000,
          },
          { actor: "model", threadId: "live-web-fixture" },
        );
        expect(article.status).toBe("success");
        z.object({ method: z.literal("http"), text: z.string().min(80) }).parse(
          article.data,
        );
        const rendered = await executeLocalCommand({
          text: '/action online.fetch {"url":"https://quotes.toscrape.com/js/","method":"auto","maxChars":2000}',
          threadId: "live-web-fixture",
          registry,
          store: createMemoryStore(database),
        });
        expect(rendered.receipt?.status).toBe("success");
        expect(rendered.receipt?.action).toBe("web.read");
        const content = z
          .object({
            method: z.literal("browser"),
            text: z.string(),
            untrusted: z.literal(true),
            sourceId: z.string().regex(/^web:/),
          })
          .parse(rendered.receipt?.data);
        expect(content.text).toContain("Albert Einstein");
      } finally {
        await browser.close();
        database.close();
      }
    }, 60000);
  },
);
