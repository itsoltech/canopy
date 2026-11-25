import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { PermissionMode, Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ANTIGRAVITY_ACP_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { snapshot } from "./support/thread-move.ts";

const makeTemp = tempDirs();
const executable = resolve(import.meta.dir, "../../apps/worker/src/providers/antigravity/fixtures/agent.ts");

async function withWorker<T>(
  gateway: TestGateway,
  registration: Awaited<ReturnType<TestGateway["addWorker"]>>,
  dataDir: string,
  run: () => Promise<T>,
): Promise<T> {
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir,
    clientVersion: "test",
    deviceHomes: {
      codex: join(dataDir, "device-codex"),
      claude: join(dataDir, "device-claude"),
      antigravity: join(dataDir, "device-agy"),
    },
    probe: {
      which: () => null,
      version: (path) => (path === executable ? "1.5.16" : undefined),
      realDirectory: (p) => p,
      login: () => "fixture login",
    },
  });

  try {
    const link = await openGatewayLink({
      baseUrl: gateway.grpcUrl,
      credential: registration.credential,
      hello: {
        workerId: registration.workerId,
        capabilities: [ANTIGRAVITY_ACP_CAPABILITY, "provider_account_status"],
        ...(await runtime.runPromise(journalHello())),
      },
    });

    const serving = serveLink(link, host, runtime);

    try {
      const available = await eventually(
        async () => {
          const worker = (await gateway.api.getOverview({})).workers.find((w) => w.id === registration.workerId);

          return (
            worker?.online && worker.providerInstances.some((i) => i.harness === Provider.ANTIGRAVITY && i.available)
          );
        },
        Boolean,
        15_000,
      );

      expect(available).toBe(true);

      return await run();
    } finally {
      link.close();
      await serving;
    }
  } finally {
    await host.close();
    await runtime.dispose();
  }
}

async function stateWhen(gateway: TestGateway, threadId: string, matches: (state: ui.ThreadSnapshot) => boolean) {
  const state = await eventually(() => snapshot(gateway, threadId), matches, 15_000);

  if (!matches(state))
    throw new Error(`Timed out waiting for ACP thread. Turn states: ${state.turns.map((t) => t.status).join(", ")}.`);

  return state;
}

const replies = (state: ui.ThreadSnapshot, turnId: string) =>
  state.items.flatMap(({ item, turnId: owner }) =>
    owner === turnId && item?.content.case === "agentMessage" ? [item.content.value.text] : [],
  );

async function signIn(gateway: TestGateway, workerId: string, accountStateFile: string) {
  const account = async () =>
    (await gateway.api.listProviderInstances({})).instances
      .find((i) => i.harness === Provider.ANTIGRAVITY && i.id === "native")
      ?.workers.find((w) => w.workerId === workerId)?.account;

  const catalog = async () =>
    (await gateway.api.listModels({ workerId })).workers
      .find((w) => w.workerId === workerId)
      ?.profiles.find((p) => p.provider === Provider.ANTIGRAVITY && p.profileId === "native");

  const refresh = async () => {
    const result = await gateway.api.refreshProviders({
      workerId,
      harness: Provider.ANTIGRAVITY,
      id: "native",
      accountOnly: true,
    });

    expect(result.skipped).toEqual([]);

    return account();
  };

  expect(await eventually(account, (status) => status?.state === "signed_out")).toMatchObject({ state: "signed_out" });
  expect(await eventually(catalog, (profile) => Boolean(profile?.detail))).toMatchObject({
    models: [],
    detail: "Authentication required",
  });

  await Bun.write(accountStateFile, "error");
  expect(await refresh()).toMatchObject({ state: "error", detail: "Could not read account status from the CLI." });

  await Bun.write(accountStateFile, "signed_in");
  expect(await refresh()).toMatchObject({ state: "signed_in", authMethod: "Account", email: "", configDir: "" });

  return eventually(catalog, (profile) => Boolean(profile?.models.length), 15_000);
}

test.skipIf(!dockerAvailable)(
  "native Antigravity recovers its catalog after device sign-in, runs scoped MCP, forwards approval, resumes and interrupts",
  async () => {
    const gateway = await startTestGateway();

    try {
      const dataDir = makeTemp("canopy-agy-worker-");
      const repo = makeTemp("canopy-agy-workspace-");
      const accountStateFile = join(dataDir, "device-account-state");
      await Bun.write(accountStateFile, "signed_out");
      const registration = await gateway.addWorker("Antigravity", [repo]);
      const { workerId } = registration;
      await gateway.runtime.runPromise(
        GatewayStore.use((s) =>
          s.setWorkerConfig(
            workerId,
            {
              allowedRoots: [repo],
              antigravity: { enabled: true, executablePath: executable },
            },
            gateway.userId,
          ),
        ),
      );
      await gateway.api.saveProviderInstance({
        harness: Provider.ANTIGRAVITY,
        id: "native",
        kind: ProviderProfileKind.NATIVE,
        env: [{ name: "TEST_AGY_ACCOUNT_STATE", value: accountStateFile }],
      });
      const model = "gemini-4-carbon";
      const answer = model + ", high, deny";

      const threadId = await withWorker(gateway, registration, dataDir, async () => {
        const catalog = (await signIn(gateway, workerId, accountStateFile))?.models;

        expect(catalog?.find((m) => m.isDefault)).toMatchObject({
          id: "gemini-3.1-pro",
          defaultEffort: "low",
        });
        expect(catalog?.find((m) => m.id === model)?.efforts).toEqual(["low", "high"]);
        const projectId = (await gateway.api.createProject({ name: "Antigravity" })).project!.id;
        const workspaceId = (await gateway.api.createWorkspace({ projectId, workerId, rootPath: repo })).workspace!.id;

        const threadId = (
          await gateway.api.createThread({
            projectId,
            workspaceId,
            title: "Native ACP",
            provider: Provider.ANTIGRAVITY,
            model,
            effort: "high",
            permissionMode: PermissionMode.ASK,
            clientRequestId: crypto.randomUUID(),
          })
        ).thread!.id;

        const idle = await eventually(
          () => gateway.api.getThread({ threadId }),
          (r) => r.thread?.status === "idle",
          15_000,
        );

        expect(idle.thread?.status).toBe("idle");

        const turnId = (
          await gateway.api.sendMessage({
            threadId,
            text: "Review with approval",
            clientRequestId: crypto.randomUUID(),
          })
        ).turn!.id;

        const pending = (state: ui.ThreadSnapshot) =>
          state.interactions.find((i) => i.turnId === turnId && i.status === "pending");

        const waiting = await stateWhen(gateway, threadId, (s) => !!pending(s));
        const approval = pending(waiting);
        expect(approval?.toolName).toBe("File review.txt");
        const target = join(repo, "review.txt");
        expect(JSON.parse(approval!.requestJson)).toMatchObject({
          input: { Path: target },
          locations: [{ path: target }],
        });
        await gateway.api.answerInteraction({ requestId: approval!.requestId, allow: false });

        const finished = await stateWhen(gateway, threadId, (s) =>
          s.turns.some((t) => t.id === turnId && t.status === "completed"),
        );

        expect(replies(finished, turnId)).toContain(answer);
        expect(finished.turns.find((t) => t.id === turnId)?.usage).toMatchObject({
          model,
          inputTokens: 20n,
          outputTokens: 5n,
          cachedInputTokens: 5n,
          reasoningOutputTokens: 3n,
        });
        expect(
          finished.items.some(
            ({ item, turnId: owner }) =>
              owner === turnId &&
              item?.content.case === "agentBusCall" &&
              item.content.value.toolName === "list_threads" &&
              !item.content.value.isError,
          ),
        ).toBe(true);

        return threadId;
      });

      await withWorker(gateway, registration, dataDir, async () => {
        const resumed = (
          await gateway.api.sendMessage({
            threadId,
            text: "Recall the previous review",
            clientRequestId: crypto.randomUUID(),
          })
        ).turn!.id;

        const completed = await stateWhen(gateway, threadId, (s) =>
          s.turns.some((t) => t.id === resumed && t.status === "completed"),
        );

        expect(replies(completed, resumed)).toContain("Restored: " + answer);

        const interrupted = (
          await gateway.api.sendMessage({
            threadId,
            text: "Wait for interruption",
            clientRequestId: crypto.randomUUID(),
          })
        ).turn!.id;

        await stateWhen(gateway, threadId, (s) => replies(s, interrupted).includes("Waiting for interruption"));

        await gateway.api.interruptThread({ threadId });

        await stateWhen(gateway, threadId, (s) =>
          s.turns.some((t) => t.id === interrupted && t.status === "interrupted"),
        );
      });
    } finally {
      await gateway.close();
    }
  },
  90_000,
);
