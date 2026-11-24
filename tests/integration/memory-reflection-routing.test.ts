import { expect, test } from "bun:test";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, UsageScope } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { SqlClient } from "effect/sql";
import { tickReflection } from "../../apps/gateway/src/memory/reflection-job.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const model = "gpt-5.5";

function generationWorker(efforts: string[]) {
  return {
    hello: { capabilities: ["generate_text"] },
    models: [
      {
        provider: Provider.CODEX,
        profileId: "native",
        models: [
          { id: "default", resolvedModel: model, efforts: ["low"] },
          { id: model, efforts },
        ],
      },
    ],
  };
}

async function connectGenerator(gw: TestGateway, name: string, shared = false) {
  const { workerId, credential } = await gw.addWorker(name);

  if (shared)
    await gw.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => sql`UPDATE workers SET owner_user_id=NULL WHERE id=${workerId}::uuid`),
    );
  const worker = await gw.connect(workerId, credential, undefined, generationWorker(["high"]));
  worker.handlers.set("generateText", (_command, reply) =>
    reply(true, {
      generatedText: '{"proposals":[]}',
      consumedUsage: { model, scope: UsageScope.TURN, inputTokens: 10n },
    }),
  );
  await eventually(
    () => gw.api.listModels({}),
    (catalog) => catalog.workers.some((w) => w.workerId === workerId && w.configVersion > 0n),
  );

  return { workerId, worker };
}

async function projectWithMessage(gw: TestGateway, name: string) {
  const project = (await gw.api.createProject({ name })).project!;
  const rootPath = `/repo/${name}`;

  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath }))
    .workspace!;

  const thread = (
    await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Navigation",
      initialMessage: "After UI changes, show a screenshot.",
      provider: Provider.CODEX,
    })
  ).thread!;

  await eventually(
    () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(thread.id))),
    (turns) => turns.length === 1 && turns[0]?.status === "completed",
  );
  await gw.api.setThreadArchived({ threadId: thread.id, archived: true });

  return project.id;
}

test.skipIf(!dockerAvailable)(
  "each reflection run chooses an owned worker offering the saved model and effort without a workspace",
  async () => {
    const gw = await startTestGateway({ worker: generationWorker(["low"]) });

    try {
      const projects = [await projectWithMessage(gw, "navigation"), await projectWithMessage(gw, "settings")];
      const first = await connectGenerator(gw, "First generator");
      const shared = await connectGenerator(gw, "Shared generator", true);
      await gw.api.updateMemoryReflection({
        settings: {
          enabled: true,
          intervalMinutes: 60,
          projectIds: projects,
          provider: Provider.CODEX,
          profileId: "native",
          model,
          effort: "high",
        },
      });
      // A setting saved before automatic routing still has a pin to the source worker.
      await gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql`UPDATE memory_reflection_settings SET worker_id=${gw.workerId}::uuid WHERE owner_user_id=${gw.userId}::uuid`,
        ),
      );

      const start = new Date(Date.now() + 1000);
      await tickReflection(gw.core, start);
      const runs = () => gw.api.getMemoryHabits({});
      const completed = await runs();
      expect(completed.settings?.lastRunState).toBe("completed");
      expect(completed.settings?.intervalMinutes).toBe(60);
      expect(completed.usage?.attempts).toBe(1);
      const command = first.worker.commands.find((kind) => kind.case === "generateText");
      expect(command?.value).toMatchObject({
        provider: Provider.CODEX,
        profileId: "native",
        model,
        effort: "high",
      });
      expect(command?.value.prompt).toContain("After UI changes, show a screenshot.");
      expect(command?.value.prompt).not.toContain("/repo/");

      for (const id of projects) expect(command?.value.prompt).not.toContain(id);

      first.worker.link.close();
      await eventually(
        async () => gw.core.online.has(first.workerId),
        (online) => !online,
      );
      const next = timestampDate(completed.settings!.nextRunAt!);
      expect(next.getTime() - start.getTime()).toBe(60 * 60_000);
      await tickReflection(gw.core, new Date(next.getTime() - 1));
      expect((await runs()).settings?.lastRunState).toBe("completed");

      await tickReflection(gw.core, next);
      const unavailable = await runs();
      expect(unavailable.settings?.lastRunState).toBe("unavailable");
      expect(unavailable.usage?.attempts).toBe(1);
      expect(shared.worker.commands.some((kind) => kind.case === "generateText")).toBe(false);
      expect(gw.worker.commands.some((kind) => kind.case === "generateText")).toBe(false);

      const second = await connectGenerator(gw, "New generator");
      await tickReflection(gw.core, timestampDate(unavailable.settings!.nextRunAt!));
      const rerouted = await runs();
      expect(rerouted.settings?.lastRunState).toBe("completed");
      expect(rerouted.usage?.attempts).toBe(2);
      const usage = await gw.api.getUsageStats({ days: 7, activityKind: "generation" });
      expect(usage.workers.map((worker) => worker.workerId).sort()).toEqual([first.workerId, second.workerId].sort());
    } finally {
      await gw.close();
    }
  },
  60_000,
);
