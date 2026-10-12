import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { AGS_CHECK_ARGS } from "../../shared/ags";
import { safeProgramToken } from "../../shared/software";
import { agsCapabilities } from "../capabilities/ags";
import { registryForDatabase } from "../capabilities/catalog";
import { createRegistry, type ActionContext } from "../capabilities/registry";
import { softwareCapabilities } from "../capabilities/software";
import { saveAgsCheck } from "../db/ags-check";
import { migrateDatabase, VERBO_MIGRATIONS } from "../db/migrate";
import { createRootStore } from "../db/registered-roots";
import { createScopeStore } from "../db/scopes";
import {
  clearSoftwareCache,
  locateProgramFiles,
  type SoftwareSource,
} from "../software/inventory";
import { readInstalledPrograms } from "../platform/win-registry";

const databases: DatabaseSync[] = [];
const directories: string[] = [];
const context: ActionContext = {
  actor: "model",
  threadId: "thread-1",
  turnId: "turn-1",
};

afterEach(() => {
  clearSoftwareCache();
  delete process.env.VERBO_PHASE6_SENTINEL;
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "verbo-phase6-"));
  directories.push(directory);
  const db = new DatabaseSync(join(directory, "verbo.sqlite"));
  databases.push(db);
  migrateDatabase(db, VERBO_MIGRATIONS);
  return db;
}

function folder(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), name));
  directories.push(directory);
  return directory;
}

describe("phase 6 environment, projects, software, and AGS", () => {
  it("lists well-known folders and aliases without environment secrets", () => {
    process.env.VERBO_PHASE6_SENTINEL = "super-secret-value";
    const db = database();
    const root = folder("verbo-alias-");
    createScopeStore(db).apply({
      removeIds: [],
      updates: [],
      additions: [
        {
          alias: "notes",
          path: root,
          read: true,
          write: true,
          defaultSave: false,
        },
      ],
    });
    createRootStore(db, "registered_projects", "project").add("demo", root);
    const listed = registryForDatabase(db).invoke(
      "environment.paths",
      {},
      context,
    );
    expect(listed.status).toBe("success");
    expect(listed.detail).toContain("notes");
    expect(listed.detail).toContain("demo");
    expect(listed.detail).not.toContain("super-secret-value");
    expect(listed.detail).not.toContain("VERBO_PHASE6_SENTINEL");
    const body = JSON.parse(listed.detail ?? "{}") as {
      aliases: Array<{ name: string; write: boolean; kind: string }>;
    };
    expect(body.aliases.find((item) => item.name === "demo")).toMatchObject({
      kind: "project",
      write: false,
    });
  });

  it("keeps project registration from granting writes or reading an unregistered tree", () => {
    const db = database();
    const root = folder("verbo-project-");
    const outside = folder("verbo-outside-");
    writeFileSync(join(outside, "secret-outside.txt"), "hidden-secret");
    symlinkSync(outside, join(root, "link"), "junction");
    writeFileSync(join(root, "hello.txt"), "hello");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "phase6-demo",
        description: "A demo",
        scripts: { dangerous: "rm -rf /" },
        dependencies: { "left-pad": "1.0.0" },
      }),
    );
    writeFileSync(join(root, "README.md"), "Demo project\nSECRETLINE\n");
    writeFileSync(join(root, ".env"), "TOKEN=hidden-secret");
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(
      join(root, ".git", "config"),
      "[user]\n\temail = hidden-secret@example.com\n",
    );

    const denied = registryForDatabase(db).invoke(
      "projects.inspect",
      { project: root },
      context,
    );
    expect(denied.code).toBe("not_registered");
    expect(JSON.stringify(denied)).not.toContain("hidden-secret");
    expect(JSON.stringify(denied)).not.toContain("SECRETLINE");

    const saved = createRootStore(db, "registered_projects", "project").add(
      "demo",
      root,
    );
    expect(saved.ok).toBe(true);
    const scopes = db
      .prepare(`SELECT COUNT(*) AS count FROM file_scopes`)
      .get() as { count: number };
    expect(scopes.count).toBe(0);

    const inspected = registryForDatabase(db).invoke(
      "projects.inspect",
      { project: "demo" },
      context,
    );
    expect(inspected.status).toBe("success");
    expect(inspected.detail).toContain("phase6-demo");
    expect(inspected.detail).toContain("ref: refs/heads/main");
    expect(inspected.detail).toContain('"writeGranted":false');
    expect(inspected.detail).not.toContain("rm -rf");
    expect(inspected.detail).not.toContain("left-pad");
    expect(inspected.detail).not.toContain("SECRETLINE");
    expect(inspected.detail).not.toContain("hidden-secret");

    const files = registryForDatabase(db).invoke(
      "projects.files",
      { project: "demo", depth: 1 },
      { ...context, actor: "user_command" },
    );
    expect(files.status).toBe("success");
    expect(files.detail).toContain("hello.txt");
    expect(files.detail).not.toContain("secret-outside.txt");
  });

  it("rejects shell-shaped program names and pages a factual inventory", () => {
    expect(safeProgramToken("calc & whoami")).toBeNull();
    expect(safeProgramToken("..\\cmd")).toBeNull();
    const programs = [
      {
        name: "Alpha",
        version: "1",
        publisher: "A",
        location: "C:\\Alpha",
      },
      {
        name: "Beta",
        version: "2",
        publisher: "B",
        location: "",
      },
    ];
    let locateCalls = 0;
    const source: SoftwareSource = {
      platform: "win32",
      installed: () => ({ programs, complete: true }),
      locate: () => {
        locateCalls += 1;
        return [];
      },
    };
    const registry = createRegistry(softwareCapabilities(source));
    const injected = registry.invoke(
      "software.find",
      { name: "calc & whoami" },
      context,
    );
    expect(injected.code).toBe("invalid_args");
    expect(locateCalls).toBe(0);

    const found = registry.invoke("software.find", { name: "beta" }, context);
    expect(found.status).toBe("success");
    expect(found.detail).toContain("Beta");
    expect(found.detail).not.toContain("UninstallString");

    const first = registry.invoke(
      "software.list",
      { pageSize: 1 },
      context,
    );
    expect(first.detail).toContain("Alpha");
    const cursor = JSON.parse(first.detail ?? "{}").nextCursor as string;
    const second = registry.invoke(
      "software.list",
      { pageSize: 1, cursor },
      context,
    );
    expect(second.detail).toContain("Beta");
    programs.splice(0, programs.length, {
      name: "Changed",
      version: "3",
      publisher: "C",
      location: "",
    });
    clearSoftwareCache();
    const stale = registry.invoke(
      "software.list",
      { pageSize: 1, cursor },
      context,
    );
    expect(stale.code).toBe("stale_cursor");

    const temp = folder("verbo-path-");
    const seen: string[] = [];
    locateProgramFiles({
      token: "notepad",
      pathEntries: [`${temp} & calc`, temp],
      knownRoots: [],
      exists(candidate) {
        seen.push(candidate);
        return false;
      },
    });
    expect(seen).toEqual([join(temp, "notepad.exe")]);

    const linux = createRegistry(
      softwareCapabilities({
        platform: "linux",
        installed: () => ({ programs: [], complete: true }),
        locate: () => [],
      }),
    );
    expect(linux.invoke("software.list", {}, context).status).toBe(
      "not_supported",
    );
    expect(linux.invoke("software.find", { name: "vim" }, context).status).toBe(
      "not_supported",
    );
  });

  it("runs only the fixed ags check command on a registered host", () => {
    const db = database();
    const root = folder("verbo-ags-");
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "ags.yaml"),
      "format: 2\nhost: fixture\nagsVersion: 9.9.9\ncommand: calc.exe\n",
    );
    const executable = join(folder("verbo-ags-bin-"), "ags.exe");
    writeFileSync(executable, "");
    createRootStore(db, "ags_hosts", "AGS host").add("fixture", root);
    const calls: Array<{ args: readonly string[]; executable: string }> = [];
    const registry = createRegistry(
      agsCapabilities(
        () => db,
        () => createScopeStore(db),
        (input) => {
          calls.push({ args: input.args, executable: input.executable });
          return { code: 0, stdout: "checked", stderr: "", timedOut: false };
        },
      ),
    );
    const extra = registry.invoke(
      "ags.check",
      { host: "fixture", command: "calc.exe", args: ["rm"] },
      context,
    );
    expect(extra.code).toBe("invalid_args");
    expect(calls).toEqual([]);

    const unconfigured = registry.invoke(
      "ags.check",
      { host: "fixture" },
      context,
    );
    expect(unconfigured.status).toBe("not_supported");
    expect(calls).toEqual([]);

    const inspected = registry.invoke(
      "ags.inspect",
      { host: "fixture" },
      context,
    );
    expect(inspected.detail).toContain("9.9.9");
    expect(inspected.detail).not.toContain("calc.exe");

    const saved = saveAgsCheck(db, executable);
    expect(saved.ok).toBe(true);
    const checked = registry.invoke("ags.check", { host: "fixture" }, context);
    expect(checked.status).toBe("success");
    expect(calls).toEqual([
      { args: [...AGS_CHECK_ARGS], executable },
    ]);
    expect(checked.detail).not.toContain(executable);
    expect(checked.detail).toContain("checked");

    const guessed = registry.invoke(
      "ags.inspect",
      { host: folder("verbo-not-a-host-") },
      context,
    );
    expect(guessed.code).toBe("not_registered");
  });

  it("reads Windows uninstall metadata without uninstall command fields", () => {
    const read = readInstalledPrograms();
    expect(read.programs.length).toBeGreaterThan(0);
    expect(Object.keys(read.programs[0] ?? {}).sort()).toEqual([
      "location",
      "name",
      "publisher",
      "version",
    ]);
    expect(JSON.stringify(read.programs)).not.toContain("UninstallString");
  });
});
