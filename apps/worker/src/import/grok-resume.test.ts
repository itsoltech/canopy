import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AdoptImportedSessionSchema,
  AgentToolResultSchema,
  InteractionResponseSchema,
  PermissionMode,
  Provider,
  ThreadEventSchema,
  ThreadSpecSchema,
  UserInputSchema,
} from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { GrokThreads } from "../providers/grok/threads.ts";
import { resolveProfiles } from "../providers/profiles.ts";
import { adoptImportedSession } from "./adopt.ts";
import { startFakeModel } from "./fixtures/fake-model.ts";
import { installFixtureHome, treeFingerprint } from "./fixtures/install.ts";
import { WorkerImport } from "./service.ts";

/**
 * Native continue with the real Grok CLI over ACP (docs/import.md, "Grok"): an imported session directory copied into
 * the instance's sessions root loads (session/load), and the model gets its history. The fake endpoint stands in for
 * the model: no credentials, no inference. Opt-in live tests repeat this against the real API.
 */

const temp = tempDirs();

test.skipIf(!Bun.which("grok"))(
  "the real Grok loads an imported session from Canopy's private sessions root",
  async () => {
    const root = temp("canopy-import-grok-resume-");
    const home = join(root, "home");
    const dataDir = join(root, "data");
    installFixtureHome(home, ["grok"]);

    const service = new WorkerImport({
      dataDir,
      homes: () => ({ claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") }),
      config: () => undefined,
    });

    const before = treeFingerprint(join(home, ".grok"));
    const summary = (await service.scan(["grok"])).threads[0]!;
    const sessions = join(dataDir, "grok", "fixture", "sessions");

    const sessionId = adoptImportedSession(
      service,
      { claudeHome: () => "", codexHome: () => "", grokSessions: () => sessions },
      create(AdoptImportedSessionSchema, {
        sourceKey: summary.sourceKey,
        snapshot: summary.snapshot,
        profileId: "fixture",
      }),
    );

    const fake = startFakeModel();

    const profile = resolveProfiles([
      { kind: "cliproxyapi", id: "fixture", baseUrl: fake.url, apiKey: "fixture", providers: ["grok"] },
    ]).find((p) => p.config.id === "fixture")!.resolved!;

    const env = {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      TMPDIR: process.env["TMPDIR"] ?? root,
      GROK_FOLDER_TRUST: "0",
    };

    const threads = new GrokThreads({
      profile: () => ({ ...profile, env }),
      interact: async () => create(InteractionResponseSchema, { allow: false }),
      callTool: async () => create(AgentToolResultSchema, { isError: true }),
      dataDir,
      executable: Bun.which("grok")!,
      linkDeviceLogin: false,
      record: async () => create(ThreadEventSchema),
    });

    const spec = create(ThreadSpecSchema, {
      threadId: crypto.randomUUID(),
      provider: Provider.GROK,
      providerProfileId: "fixture",
      providerThreadId: sessionId,
      cwd: join(home, "project"),
      model: "fixture-grok",
      permissionMode: PermissionMode.READ_ONLY,
    });

    try {
      const turn = threads.startTurn(
        spec,
        crypto.randomUUID(),
        create(UserInputSchema, { text: "Did FIXTURE_RESUME work?" }),
      );

      const deadline = Date.now() + 25_000;

      while (!fake.requests.some((r) => r.includes("FIXTURE_RESUME")) && Date.now() < deadline) await Bun.sleep(100);
      await Promise.race([turn.catch(() => undefined), Bun.sleep(2_000)]);
      const request = fake.requests.find((r) => r.includes("FIXTURE_RESUME"));
      expect(request).toBeDefined();
      // The imported history reached the model: both earlier prompts and their answers.
      expect(request).toContain("Run the shell tool for FIXTURE_TOOL");
      expect(request).toContain("Think hard about FIXTURE_THINK");
      expect(request).toContain("FIXTURE_ANSWER FIXTURE_THINK");
    } finally {
      await threads.close();
      await fake.stop();
    }

    expect(treeFingerprint(join(home, ".grok"))).toBe(before);
    expect(existsSync(join(sessions, encodeURIComponent(join(home, "project")), sessionId, "chat_history.jsonl"))).toBe(
      true,
    );
  },
  60_000,
);
