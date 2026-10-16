import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import { runBoundedProcess } from "../capabilities/process";
import { ownBrowserProcessTree } from "../platform/process-tree";
import {
  installedObsidianPaths,
  executableIdentity,
  applicationIdentity,
  normalizeObsidianStdout,
} from "./adapter";
import {
  obsidianOperations,
  type ObsidianQualification,
} from "../../shared/obsidian";

it.skipIf(process.env.VERBO_OBSIDIAN_QUALIFICATION !== "1")(
  "qualifies the installed Obsidian CLI only in disposable isolated vaults",
  async () => {
    const base = join(process.cwd(), ".tmp", "scratch");
    const fixture = mkdtempSync(
      join(
        base,
        `${new Date().toISOString().slice(0, 10)}-obsidian-qualification-`,
      ),
    );
    const profile = join(fixture, "profile");
    const first = join(fixture, "Verbo Fixture Garden");
    const second = join(fixture, "Verbo Fixture Office");
    const firstId = "f17e000000000001",
      secondId = "f17e000000000002";
    for (const root of [first, second]) {
      for (const directory of [
        ".obsidian",
        "Inbox",
        "Archive",
        "Other",
        "Templates",
      ])
        mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(
        join(root, ".obsidian", "app.json"),
        JSON.stringify({ alwaysUpdateLinks: true, trashOption: "local" }),
      );
      writeFileSync(join(root, ".obsidian", "core-plugins.json"), "[]");
      writeFileSync(
        join(root, "Inbox", "Same.md"),
        "---\ntype: idea\n---\n# Same\nUTF-8 café 日本語\n",
      );
      writeFileSync(
        join(root, "Other", "Same.md"),
        "Different duplicate name\n",
      );
      writeFileSync(join(root, "Links.md"), "[[Inbox/Same]]\n");
      writeFileSync(
        join(root, "Templates", "Idea.md"),
        "---\ntype: idea\n---\n",
      );
    }
    writeFileSync(
      join(second, "Inbox", "Same.md"),
      "# Office identity\nOnly the second fixture vault contains this text.\n",
    );
    mkdirSync(profile);
    writeFileSync(
      join(profile, "obsidian.json"),
      JSON.stringify({
        cli: true,
        updateDisabled: true,
        vaults: {
          [firstId]: { path: first, ts: Date.now(), open: true },
          [secondId]: { path: second, ts: Date.now(), open: false },
        },
      }),
    );
    const paths = installedObsidianPaths();
    const calls: unknown[] = [];
    const record: Record<string, unknown> = {
      fixture,
      profile,
      startedAt: new Date().toISOString(),
      appPaths: paths,
      fixtureOnly: true,
      existingUserVaultsOpened: false,
      settings: { alwaysUpdateLinks: true, trashOption: "local" },
      calls,
    };
    const qualification: ObsidianQualification = {
      adapterVersion: 1,
      executableIdentity: "unavailable",
      applicationIdentity: "unavailable",
      appVersion: "unverified",
      qualifiedAt: Date.now(),
      enabled: false,
      evidence: join(fixture, "qualification.json"),
      passthrough: false,
      operations: Object.fromEntries(
        obsidianOperations.map((operation) => [
          operation,
          { supported: false, reason: "CLI qualification did not complete." },
        ]),
      ) as ObsidianQualification["operations"],
    };
    const save = (): void => {
      writeFileSync(
        join(fixture, "qualification.json"),
        JSON.stringify(record, null, 2),
      );
      writeFileSync(
        join(fixture, "support.json"),
        JSON.stringify(qualification, null, 2),
      );
    };
    function snapshot(root: string): Record<string, string> {
      const result: Record<string, string> = {};
      const pending = [root];
      while (pending.length) {
        const path = pending.shift()!;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink() || entry.name === ".obsidian") continue;
          const file = join(path, entry.name);
          if (entry.isDirectory()) pending.push(file);
          else
            result[file.slice(root.length + 1)] = createHash("sha256")
              .update(readFileSync(file))
              .digest("hex");
        }
      }
      return result;
    }
    async function cli(
      command: string,
      args: string[] = [],
      vaultId = firstId,
    ): Promise<{
      stdout: string;
      code: number | null;
      stderr: string;
      timedOut: boolean;
      cancelled: boolean;
      spawned: boolean;
    }> {
      const argv = [
        `--user-data-dir=${profile}`,
        `vault=${vaultId}`,
        command,
        ...args,
      ];
      const before = snapshot(first);
      const outcome = await runBoundedProcess({
        executable: paths.executable,
        args: argv,
        cwd: first,
        timeoutMs: 8000,
      });
      calls.push({
        command,
        argv,
        outcome,
        before,
        after: snapshot(first),
        secondVault: snapshot(second),
      });
      save();
      return { ...outcome, stdout: normalizeObsidianStdout(outcome.stdout) };
    }
    let closeTree: (() => void) | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    let appLog = "";
    try {
      qualification.executableIdentity = executableIdentity(paths.executable);
      qualification.applicationIdentity = applicationIdentity(
        paths.application,
      );
      child = spawn(
        paths.application,
        [`--user-data-dir=${profile}`, "--disable-gpu"],
        {
          cwd: fixture,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      record.ownedPid = child.pid;
      if (!child.pid)
        throw new Error("The isolated fixture app did not start.");
      closeTree = ownBrowserProcessTree(child.pid);
      child.stdout?.on("data", (data: Buffer) => {
        appLog = (appLog + data.toString()).slice(-16000);
      });
      child.stderr?.on("data", (data: Buffer) => {
        appLog = (appLog + data.toString()).slice(-16000);
      });
      await new Promise((resolve) => setTimeout(resolve, 2500));
      let version = await cli("version");
      for (let retry = 0; retry < 3 && !version.stdout.trim(); retry += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        version = await cli("version");
      }
      if (
        !version.spawned ||
        version.timedOut ||
        version.code !== 0 ||
        !/1\.12\./u.test(version.stdout)
      )
        throw new Error(`Isolated CLI unavailable: ${JSON.stringify(version)}`);
      qualification.appVersion = version.stdout.trim().slice(0, 100);
      const help = await cli("help");
      if (help.code !== 0 || !/create|read/u.test(help.stdout))
        throw new Error("The fixture CLI did not provide expected help.");
      const read = await cli("read", ["path=Inbox/Same.md"]);
      const source = readFileSync(join(first, "Inbox", "Same.md"), "utf8");
      qualification.operations.read = {
        supported:
          read.stdout === source ||
          read.stdout.replace(/\r?\n$/u, "") === source,
        reason:
          "Compared exact-path CLI output to fixture bytes with duplicate basenames and Unicode.",
      };
      const unicodeBody =
        '# Café 日本語\n\nSpaces, quotes " and a literal \\n marker.\n';
      const encoded = unicodeBody
        .replace(/\\/gu, "\\\\")
        .replace(/\n/gu, "\\n")
        .replace(/\t/gu, "\\t");
      const created = await cli("create", [
        "path=Inbox/Unicode ö note.md",
        `content=${encoded}`,
      ]);
      const createdFile = join(first, "Inbox", "Unicode ö note.md");
      const createVerified =
        created.code === 0 &&
        existsSync(createdFile) &&
        readFileSync(createdFile, "utf8") === unicodeBody;
      const collision = await cli("create", [
        "path=Inbox/Same.md",
        "content=COLLISION MUST NOT OVERWRITE",
      ]);
      const safeBody =
        '# Café 日本語\n\nSpaces and quotes " preserve this body.\n';
      const safeCreate = await cli("create", [
        "path=Inbox/Safe Unicode ö.md",
        `content=${safeBody.replace(/\n/gu, "\\n")}`,
      ]);
      const safeVerified =
        safeCreate.code === 0 &&
        existsSync(join(first, "Inbox", "Safe Unicode ö.md")) &&
        readFileSync(join(first, "Inbox", "Safe Unicode ö.md"), "utf8") ===
          safeBody;
      qualification.operations.create = {
        supported:
          safeVerified &&
          readFileSync(join(first, "Inbox", "Same.md"), "utf8") === source,
        reason: `Supported body subset read-back=${safeVerified}. Literal backslash-n/tab content read-back=${createVerified} and is rejected before approval. CLI collisions choose a suffix (exit=${collision.code}); adapter requires absent target before dispatch and exact-path/content postconditions, reporting any race as uncertain.`,
      };
      const originalHash = createHash("sha256").update(source).digest("hex");
      await cli("move", ["path=Inbox/Same.md", "to=Archive/Same.md"]);
      const moved = join(first, "Archive", "Same.md");
      qualification.operations.move = {
        supported:
          !existsSync(join(first, "Inbox", "Same.md")) &&
          existsSync(moved) &&
          createHash("sha256").update(readFileSync(moved)).digest("hex") ===
            originalHash,
        reason: `Exact path and contents checked; resulting link text: ${readFileSync(join(first, "Links.md"), "utf8").slice(0, 300)}`,
      };
      await cli("rename", ["path=Archive/Same.md", "name=Renamed.md"]);
      qualification.operations.rename = {
        supported:
          !existsSync(moved) &&
          existsSync(join(first, "Archive", "Renamed.md")),
        reason:
          "Same-directory exact rename, extension and postconditions checked.",
      };
      await cli("create", [
        "path=Archive/Renamed.md",
        "content=Edited",
        "overwrite",
      ]);
      qualification.operations.edit = {
        supported: false,
        reason:
          "The overwrite candidate was exercised, but CLI offers no expected-revision compare-and-swap contract. Native full/replace/lines equivalence remains unqualified.",
      };
      await cli("delete", ["path=Archive/Renamed.md"]);
      qualification.operations.delete = {
        supported: false,
        reason: `Fixture trashOption=local; note removed=${!existsSync(join(first, "Archive", "Renamed.md"))}. Vault-local .trash semantics are not Verbo's system Recycle Bin guarantee.`,
      };
      const cold = await cli("read", ["path=Inbox/Same.md"], secondId);
      record.coldSecondVaultRead = {
        stdout: cold.stdout,
        code: cold.code,
        timedOut: cold.timedOut,
        exact:
          cold.stdout.replace(/\r?\n$/u, "") ===
          readFileSync(join(second, "Inbox", "Same.md"), "utf8").replace(
            /\r?\n$/u,
            "",
          ),
      };
      await new Promise((resolve) => setTimeout(resolve, 800));
      const other = await cli("read", ["path=Inbox/Same.md"], secondId);
      record.secondVaultReadVerified = other.stdout.includes(
        "Only the second fixture vault contains this text.",
      );
      qualification.passthrough = true;
      record.appLog = appLog;
      record.status = "qualified_subset_disabled_pending_activation";
    } catch (error) {
      record.status = "blocked";
      record.error = String(error);
    } finally {
      record.appLog = appLog;
      closeTree?.();
      child?.kill();
      record.finishedAt = new Date().toISOString();
      save();
    }
  },
  180_000,
);
