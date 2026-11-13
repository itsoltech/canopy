/** Native device login, isolated homes and workspace. Opt in with CANOPY_LIVE=1. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DeviceLogin, PermissionMode, Provider } from "@canopy/contracts";
import { THREAD_REWIND_CAPABILITY } from "@canopy/domain/release/protocol";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const cases = [
  {
    name: "codex",
    provider: Provider.CODEX,
    login: ".codex/auth.json",
    model: process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol",
  },
  {
    name: "claude",
    provider: Provider.CLAUDE,
    login: ".claude/.credentials.json",
    model: process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5",
  },
];

for (const harness of cases)
  describe.skipIf(
    process.env["CANOPY_LIVE"] !== "1" ||
      !dockerAvailable ||
      !existsSync(join(homedir(), harness.login)) ||
      Boolean(process.env["CANOPY_LIVE_HARNESS"] && process.env["CANOPY_LIVE_HARNESS"] !== harness.name),
  )(`native ${harness.name}: in-place rewind (live)`, () => {
    let gw: TestGateway;
    let projectId: string;
    let workspaceId: string;
    let stop = async () => {};
    let repo: string;
    let data: string;

    beforeAll(async () => {
      repo = mkdtempSync(join(tmpdir(), "canopy-live-rewind-repo-"));
      data = mkdtempSync(join(tmpdir(), "canopy-live-rewind-worker-"));
      gw = await startTestGateway();

      const worker = await gw.runtime.runPromise(
        GatewayStore.use((store) => store.addWorker({ name: "live rewind", ownerUserId: gw.userId })),
      );

      await gw.runtime.runPromise(
        GatewayStore.use((store) =>
          store.setWorkerConfig(
            worker.workerId,
            {
              allowedRoots: [repo],
              codex: { enabled: harness.provider === Provider.CODEX, deviceLogin: DeviceLogin.LINK },
              claude: { enabled: harness.provider === Provider.CLAUDE, deviceLogin: DeviceLogin.LINK },
            },
            gw.userId,
            {},
          ),
        ),
      );
      const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
      const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential: worker.credential,
        hello: {
          workerId: worker.workerId,
          capabilities: [THREAD_REWIND_CAPABILITY, "full_access"],
          ...(await runtime.runPromise(journalHello())),
        },
      });

      const serving = serveLink(link, host, runtime);
      stop = async () => {
        link.close();
        await serving;
        await host.close();
        await runtime.dispose();
      };

      projectId = (await gw.api.createProject({ name: "Live rewind" })).project!.id;
      workspaceId = (await gw.api.createWorkspace({ projectId, workerId: worker.workerId, rootPath: repo })).workspace!
        .id;
      await eventually(
        async () =>
          (await gw.api.getOverview({})).workers.find((row) => row.id === worker.workerId)?.providerInstances ?? [],
        (instances) => instances.some((instance) => instance.harness === harness.provider && instance.available),
        120_000,
      );
    }, 240_000);
    afterAll(async () => {
      await stop();
      await gw?.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    });

    const snapshot = (threadId: string) => gw.runtime.runPromise(GatewayStore.use((store) => store.snapshot(threadId)));

    async function send(threadId: string, text: string) {
      const sent = (await gw.api.sendMessage({ threadId, text, clientRequestId: Bun.randomUUIDv7() })).turn!;

      const done = await eventually(
        () => snapshot(threadId),
        (state) =>
          state.turns.some(
            (turn) => turn.id === sent.id && ["completed", "failed", "interrupted"].includes(turn.status),
          ),
        240_000,
      );

      const turn = done.turns.find((row) => row.id === sent.id)!;
      expect(turn.status).toBe("completed");

      const answer = done.items
        .flatMap((row) => {
          const item = row.item;

          return row.turnId === sent.id && item?.content.case === "agentMessage" ? [item.content.value.text] : [];
        })
        .join("\n");

      return { turn, answer };
    }

    test("edited suffix is absent from the native model context; Claude can preview and restore checkpointed files", async () => {
      const thread = (
        await gw.api.createThread({
          projectId,
          workspaceId,
          provider: harness.provider,
          model: harness.model,
          effort: "low",
          permissionMode: PermissionMode.FULL_ACCESS,
          title: "Live rewind",
        })
      ).thread!;

      await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (response) => response.thread?.status === "idle",
        120_000,
      );
      const files = harness.provider === Provider.CLAUDE;
      await send(
        thread.id,
        `Remember APPLE.${files ? ' Use the Write tool with file_path "rewind.txt" and content "APPLE". This file must contain exactly APPLE.' : ""} Reply OK. Do not use other tools.`,
      );

      const target = await send(
        thread.id,
        `Remember BANANA.${files ? ' Use the Edit tool on "rewind.txt" with old_string "APPLE" and new_string "BANANA". This file must now contain exactly BANANA.' : ""} Reply OK. Do not use other tools.`,
      );

      await send(thread.id, "Remember CHERRY. Reply OK only, no tools.");

      if (files) expect(readFileSync(join(repo, "rewind.txt"), "utf8").trim()).toBe("BANANA");
      const preview = await gw.api.prepareThreadRewind({ threadId: thread.id, turnId: target.turn.id });

      if (files) {
        expect(preview.filesAvailable).toBe(true);
        expect(preview.files.some((file) => file.endsWith("rewind.txt"))).toBe(true);
      }

      const result = await gw.api.rewindThread({
        threadId: thread.id,
        turnId: target.turn.id,
        clientRequestId: Bun.randomUUIDv7(),
        restoreFiles: files,
      });

      expect(result.status).toBe("completed");

      if (files) expect(readFileSync(join(repo, "rewind.txt"), "utf8").trim()).toBe("APPLE");

      const edited = await send(
        thread.id,
        "Remember BLUEBERRY. List all the fruit words I told you to remember in this conversation. No tools.",
      );

      expect(edited.answer.toUpperCase()).toContain("APPLE");
      expect(edited.answer.toUpperCase()).toContain("BLUEBERRY");
      expect(edited.answer.toUpperCase()).not.toContain("BANANA");
      expect(edited.answer.toUpperCase()).not.toContain("CHERRY");
    }, 900_000);
  });
