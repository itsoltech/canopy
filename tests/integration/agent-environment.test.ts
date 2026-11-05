/** Desired instructions travel over the real UI RPC and worker link; every harness home is disposable. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { environmentBlock, readEnvironmentBlock } from "@canopy/domain/agent-environment";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { AgentEnvironment } from "../../apps/gateway/src/agent-environment/service.ts";
import { eventually, failure, startTestGateway } from "./support/gateway.ts";

const root = tempDir("canopy-agent-environment-");
let gateway: Awaited<ReturnType<typeof startTestGateway>>;

type Machine = Awaited<ReturnType<typeof machine>>;

const machines: Machine[] = [];
let linux: Machine;
let windows: Machine;

async function machine(name: string, os: string, capable = true) {
  const registration = await gateway.addWorker(name);
  const home = join(root, name, "home");
  const dataDir = join(root, name, "data");
  const deviceHomes = { claude: join(home, ".claude"), codex: join(home, ".codex") };
  mkdirSync(deviceHomes.claude, { recursive: true });
  writeFileSync(join(deviceHomes.claude, "CLAUDE.md"), "My private local notes.\n");
  await gateway.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        registration.workerId,
        {
          claude: { enabled: false },
          codex: { enabled: false },
          grok: { enabled: false },
        },
        gateway.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir,
    deviceHomes,
    clientVersion: "test",
    probe: { which: () => null, version: () => undefined, realDirectory: (path) => path },
    cliProbe: {
      platform: "linux",
      home,
      docker: false,
      locate: () => [],
      which: () => null,
      realpath: () => undefined,
      version: async () => ({ error: "not installed" }),
    },
  });

  const connect = async () => {
    const link = await openGatewayLink({
      baseUrl: gateway.grpcUrl,
      credential: registration.credential,
      hello: {
        workerId: registration.workerId,
        host: { os, arch: "x64", hostname: name },
        environmentKind: "desktop",
        capabilities: capable ? ["agent_environment_v1"] : [],
      },
    });

    const serving = serveLink(link, host, runtime);

    return { link, serving };
  };

  const connection = await connect();

  return { ...registration, ...connection, connect, host, runtime, deviceHomes, dataDir };
}

beforeAll(async () => {
  gateway = await startTestGateway();
  linux = await machine("linux-laptop", "linux");
  machines.push(linux);
  windows = await machine("windows-desktop", "win32");
  machines.push(windows);
  await eventually(
    () => gateway.api.getAgentEnvironment({}),
    (s) => s.workers.filter((w) => w.supported).length === 2,
  );
}, 60_000);

afterAll(async () => {
  for (const m of machines) {
    m.link.close();
    await m.serving;
    await m.host.close();
    await m.runtime.dispose();
  }

  if (gateway) await gateway.close();
});

async function snapshot() {
  return gateway.api.getAgentEnvironment({});
}

async function settled(workerId = linux.workerId) {
  const result = await eventually(
    snapshot,
    (s) => s.workers.find((w) => w.workerId === workerId)?.report?.revision === s.revision,
  );

  const worker = result.workers.find((w) => w.workerId === workerId)!;
  expect(worker.report?.revision).toBe(result.revision);

  return worker;
}

async function save(document: ui.InstructionDocument) {
  return gateway.api.saveInstructionDocument({ expectedRevision: (await snapshot()).revision, document });
}

const document = (harness = "claude") =>
  create(ui.InstructionDocumentSchema, {
    name: `${harness} working style`,
    harness,
    deviceHome: true,
    platformHome: true,
    selector: { everyone: true },
    fragments: [
      { id: "base", name: "Base", content: "Be concise." },
      { id: "windows", name: "Windows", content: "Use PowerShell.", selector: { tags: ["os:windows"] } },
      {
        id: "work",
        name: "Work",
        content: "Run project checks.",
        selector: { tags: ["work", "os:linux"], matchAllTags: true },
      },
    ],
    overrides: [{ workerId: linux?.workerId, content: "Laptop-specific note." }],
  });

describe("agent environment across gateway and workers", () => {
  test("facts and manual tags compose separately per machine, without enabling old workers", async () => {
    const initial = await snapshot();
    expect(initial.workers.find((w) => w.workerId === gateway.workerId)?.supported).toBe(false);
    expect(initial.workers.find((w) => w.workerId === linux.workerId)?.automaticTags).toEqual(
      expect.arrayContaining(["os:linux", "arch:x64", "kind:desktop", "hostname:linux-laptop"]),
    );
    expect(initial.workers.find((w) => w.workerId === windows.workerId)?.automaticTags).toContain("os:windows");
    await gateway.api.setEnvironmentTags({
      workerId: linux.workerId,
      tags: ["work"],
      expectedRevision: initial.revision,
    });
    await save(document());
    const worker = await settled();
    const content = worker.preview.find((i) => i.harness === "claude" && i.platformHome)?.content;
    expect(content).toBe("Be concise.\n\nRun project checks.\n\nLaptop-specific note.");
    const win = await settled(windows.workerId);
    expect(win.preview.find((i) => i.harness === "claude")?.content).toBe("Be concise.\n\nUse PowerShell.");
    const file = readFileSync(join(linux.deviceHomes.claude, "CLAUDE.md"), "utf8");
    expect(file).toStartWith("My private local notes.\n");
    expect(readEnvironmentBlock(file)?.content).toBe(content);
    expect(readFileSync(join(linux.dataDir, "claude-home/CLAUDE.md"), "utf8")).toContain(environmentBlock(content!));
    expect(JSON.stringify(worker.report?.files)).not.toContain("My private local notes.");
    expect(readdirSync(linux.deviceHomes.claude)).toEqual(["CLAUDE.md"]);

    const old = await machine("older-worker", "linux", false);
    machines.push(old);
    await eventually(snapshot, (s) =>
      s.workers.some((w) => w.workerId === old.workerId && w.automaticTags.includes("os:linux")),
    );
    const connection = gateway.core.link.connections.get(old.workerId)!;
    expect((await connection.sendCommand({ case: "listDirectory", value: { path: root } })).ok).toBe(true);
    expect(readFileSync(join(old.deviceHomes.claude, "CLAUDE.md"), "utf8")).toBe("My private local notes.\n");
    expect(existsSync(join(old.dataDir, "claude-home", "CLAUDE.md"))).toBe(false);
  });

  test("draft preview is unsaved and include/exclude tags and machine disable win", async () => {
    const before = await snapshot();
    const draft = clone(ui.InstructionDocumentSchema, before.documents[0]!);
    draft.selector!.excludeTags = ["os:windows"];
    draft.overrides = [{ workerId: linux.workerId, disabled: true }].map((o) =>
      create(ui.InstructionMachineOverrideSchema, o),
    );

    for (const workerId of [linux.workerId, windows.workerId]) {
      const preview = await gateway.api.previewAgentEnvironment({ workerId, draft });
      expect(preview.instructions.every((i) => !i.content)).toBe(true);
    }

    expect((await snapshot()).revision).toBe(before.revision);
    expect((await snapshot()).documents[0]?.selector?.excludeTags).toEqual([]);
  });

  test("local drift is reported, keep survives scans and overwrite is a one-shot choice", async () => {
    const path = join(linux.deviceHomes.claude, "CLAUDE.md");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace("Be concise.", "My local version."));
    linux.host.environment.refresh(true);

    const drift = await eventually(
      snapshot,
      (s) =>
        s.workers.find((w) => w.workerId === linux.workerId)?.report?.files.some((f) => f.status === "drift") ?? false,
    );

    const file = drift.workers
      .find((w) => w.workerId === linux.workerId)!
      .report!.files.find((f) => f.status === "drift")!;

    expect(file.managedContent).toContain("My local version.");
    expect(file.importable).toBe(true);
    await gateway.api.resolveEnvironmentDrift({
      workerId: linux.workerId,
      targetId: file.targetId,
      observedChecksum: file.observedChecksum,
      action: "keep",
      expectedRevision: drift.revision,
    });
    expect((await settled()).report?.files.find((f) => f.targetId === file.targetId)?.status).toBe("kept");
    linux.host.environment.refresh(true);
    expect(readFileSync(path, "utf8")).toContain("My local version.");
    const kept = await snapshot();
    await gateway.api.resolveEnvironmentDrift({
      workerId: linux.workerId,
      targetId: file.targetId,
      observedChecksum: file.observedChecksum,
      action: "overwrite",
      expectedRevision: kept.revision,
    });
    expect((await settled()).report?.files.find((f) => f.targetId === file.targetId)?.status).toBe("applied");
    expect(readFileSync(path, "utf8")).toBe(original);
    // Returning to the exact earlier local bytes must ask again, rather than replaying overwrite.
    writeFileSync(path, original.replace("Be concise.", "My local version."));
    linux.host.environment.refresh(true);
    await eventually(
      snapshot,
      (s) =>
        s.workers.find((w) => w.workerId === linux.workerId)?.report?.files.some((f) => f.status === "drift") ?? false,
    );
    await gateway.core.environment.sync(linux.workerId);
    expect((await settled()).report?.files.find((f) => f.targetId === file.targetId)?.status).toBe("drift");
  });

  test("import replaces only this machine's composition and keeps outside text private", async () => {
    const state = await snapshot();

    const file = state.workers
      .find((w) => w.workerId === linux.workerId)!
      .report!.files.find((f) => f.status === "drift")!;

    const result = await gateway.api.resolveEnvironmentDrift({
      workerId: linux.workerId,
      targetId: file.targetId,
      observedChecksum: file.observedChecksum,
      action: "import",
      expectedRevision: state.revision,
    });

    expect(result.documents).toHaveLength(2);
    const imported = result.documents.find((d) => d.name.startsWith("Imported"))!;
    expect(imported.selector?.workerIds).toEqual([linux.workerId]);
    expect(imported.fragments[0]?.content).toContain("My local version.");
    expect(imported.fragments[0]?.content).not.toContain("My private local notes.");
    expect((await settled()).preview.find((i) => i.harness === "claude")?.content).toBe(imported.fragments[0]?.content);
    expect((await settled(windows.workerId)).preview.find((i) => i.harness === "claude")?.content).not.toContain(
      "My local version.",
    );
  });

  test("offline edits catch up on reconnect and removal preserves user text", async () => {
    linux.link.close();
    await linux.serving;
    await save(document("codex"));
    const current = await snapshot();
    expect(current.workers.find((w) => w.workerId === linux.workerId)?.online).toBe(false);
    Object.assign(linux, await linux.connect());
    expect((await settled()).report?.files.filter((f) => f.harness === "codex" && f.status === "applied")).toHaveLength(
      2,
    );
    expect(readFileSync(join(linux.deviceHomes.codex, "AGENTS.md"), "utf8")).toContain("Be concise.");

    for (const doc of (await snapshot()).documents) {
      await gateway.api.deleteInstructionDocument({ id: doc.id, expectedRevision: (await snapshot()).revision });
    }

    await settled();
    expect(readEnvironmentBlock(readFileSync(join(linux.deviceHomes.claude, "CLAUDE.md"), "utf8"))).toBeUndefined();
    expect(readFileSync(join(linux.deviceHomes.claude, "CLAUDE.md"), "utf8")).toContain("My private local notes.");
  });

  test("foreign documents, workers, previews and drift actions remain owner scoped", async () => {
    const owner = await gateway.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("other@localhost", "Other")));

    const foreignWorker = await gateway.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "private", ownerUserId: owner })),
    );

    const foreign = new AgentEnvironment({
      runtime: gateway.runtime,
      userId: owner,
      link: gateway.core.link,
      changed: () => {},
    });

    const doc = document();
    doc.overrides = [];

    const created = await foreign.save(
      create(ui.SaveInstructionDocumentRequestSchema, { document: doc, expectedRevision: 0n }),
    );

    const id = created.documents[0]!.id;
    const state = await snapshot();
    expect(state.documents.some((d) => d.id === id)).toBe(false);
    expect(state.workers.some((w) => w.workerId === foreignWorker.workerId)).toBe(false);
    expect(await failure(gateway.api.deleteInstructionDocument({ id, expectedRevision: state.revision }))).toContain(
      "not found",
    );
    expect(await failure(gateway.api.previewAgentEnvironment({ workerId: foreignWorker.workerId }))).toContain(
      "not found",
    );
    expect(
      await failure(
        gateway.api.setEnvironmentTags({
          workerId: foreignWorker.workerId,
          tags: ["work"],
          expectedRevision: state.revision,
        }),
      ),
    ).toContain("not found");
    expect(
      await failure(
        gateway.api.resolveEnvironmentDrift({
          workerId: foreignWorker.workerId,
          action: "overwrite",
          expectedRevision: state.revision,
        }),
      ),
    ).toContain("not found");
    doc.id = id;
    expect(await failure(save(doc))).toContain("not found");
    expect((await foreign.snapshot()).documents[0]?.fragments[0]?.content).toBe("Be concise.");
  });

  test("new worker facts that exceed composition limits stay connected with a visible error", async () => {
    for (const name of ["First large fragment", "Second large fragment"]) {
      await save(
        create(ui.InstructionDocumentSchema, {
          name,
          harness: "claude",
          platformHome: true,
          selector: { tags: ["os:freebsd"] },
          fragments: [{ id: "base", name: "Base", content: "x".repeat(14 * 1024) }],
        }),
      );
    }

    const freebsd = await machine("freebsd-server", "freebsd");
    machines.push(freebsd);

    const result = await eventually(snapshot, (s) =>
      Boolean(s.workers.find((w) => w.workerId === freebsd.workerId)?.compositionError),
    );

    const worker = result.workers.find((w) => w.workerId === freebsd.workerId)!;
    expect(worker.online).toBe(true);
    expect(worker.compositionError).toContain("24 KiB");
    expect((await settled()).report?.revision).toBe(result.revision);
    const doc = result.documents[0]!;
    expect(
      await failure(gateway.api.deleteInstructionDocument({ id: doc.id, expectedRevision: result.revision - 1n })),
    ).toContain("changed");
    await gateway.api.deleteInstructionDocument({ id: doc.id, expectedRevision: result.revision });
    expect((await settled(freebsd.workerId)).report?.files.some((f) => f.status === "applied")).toBe(true);
  });
});
