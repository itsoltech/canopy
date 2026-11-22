import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, ui, UsageScope } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tickReflection } from "../../apps/gateway/src/memory/reflection-job.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("memory reflection from owner messages to a worker turn", () => {
  let gateway: TestGateway | undefined;

  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  test("finds a repeated request, respects the interval and delivers an approved habit once", async () => {
    const gw = await startTestGateway({
      worker: {
        hello: { capabilities: ["generate_text", "memory_habits_v1"] },
        models: [
          {
            provider: Provider.CODEX,
            profileId: "native",
            models: [
              { id: "gpt-6-luna", displayName: "GPT-6-Luna", efforts: ["low", "medium"] },
              { id: "gpt-6.2-astra", displayName: "GPT-6.2-Astra", isDefault: true, efforts: ["high"] },
            ],
          },
        ],
      },
    });

    gateway = gw;
    const project = (await gw.api.createProject({ name: "Canopy UI" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    const newThread = async (title: string, initialMessage = "") =>
      (
        await gw.api.createThread({
          projectId: project.id,
          workspaceId: workspace.id,
          provider: Provider.CODEX,
          title,
          initialMessage,
        })
      ).thread!;

    const complete = (id: string) =>
      eventually(
        () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(id))),
        (turns) => !!turns.length && turns.every((turn) => turn.status === "completed"),
      );

    const examples: readonly [title: string, text: string][] = [
      ["Navigation layout", "After UI changes, show a screenshot of the navigation."],
      ["Settings layout", "Po zmianach UI pokaż zrzut ekranu ustawień."],
      ["Mobile layout", "After changing the UI, show a screenshot of the updated screen."],
    ];

    for (const [index, [title, text]] of examples.entries()) {
      const thread = await newThread(title, index === 0 ? text : "");

      if (index !== 0) await gw.api.sendMessage({ threadId: thread.id, clientRequestId: crypto.randomUUID(), text });
      await complete(thread.id);
      await gw.api.setThreadArchived({ threadId: thread.id, archived: true });
    }

    const automated = await newThread("Automated instruction");
    const automationText = "After UI changes, show the automation canary screenshot.";
    await gw.core.sendMessage(create(ui.SendMessageRequestSchema, { threadId: automated.id, text: automationText }));
    await complete(automated.id);
    await gw.api.setThreadArchived({ threadId: automated.id, archived: true });

    const prompts: string[] = [];
    const models: string[] = [];
    gw.worker.handlers.set("generateText", (command, reply) => {
      if (!("prompt" in command)) return reply(false);
      prompts.push(command.prompt);
      models.push(command.model);
      reply(true, {
        consumedUsage: {
          model: command.model,
          scope: UsageScope.TURN,
          inputTokens: 300n,
          outputTokens: 50n,
          reportedCostUsd: 0.0005,
        },
        generatedText: JSON.stringify({
          proposals: [
            { condition: "ui_changes", action: "show_screenshot", signal: "request", sources: ["m1", "m2", "m3"] },
          ],
        }),
      });
    });

    const before = await gw.api.getMemoryHabits({});
    expect(before.settings?.enabled).toBe(false);
    expect(before.settings?.intervalMinutes).toBe(1440);
    await tickReflection(gw.core);
    expect(prompts).toEqual([]);

    await gw.api.updateMemoryReflection({
      settings: {
        enabled: true,
        intervalMinutes: 720,
        projectIds: [project.id],
        workerId: gw.workerId,
        provider: Provider.CODEX,
        profileId: "native",
        revision: before.settings!.revision,
      },
    });

    const now = new Date(Date.now() + 1000);
    await tickReflection(gw.core, now);
    const reviewed = await gw.api.getMemoryHabits({});
    expect(reviewed.settings?.lastRunState).toBe("completed");
    expect(reviewed.settings?.intervalMinutes).toBe(720);
    expect(reviewed.usage).toMatchObject({
      attempts: 1,
      inputTokens: 300n,
      outputTokens: 50n,
      reportedCostUsd: 0.0005,
    });
    expect(timestampDate(reviewed.settings!.nextRunAt!).getTime() - now.getTime()).toBe(720 * 60_000);
    expect(models).toEqual(["gpt-6-luna"]);
    expect(prompts[0]).toContain("zrzut ekranu");
    expect(prompts[0]).not.toContain(automationText);
    expect(reviewed.suggestions).toHaveLength(1);
    const habit = reviewed.suggestions[0]!;
    expect(habit.evidenceCount).toBe(3);
    expect(habit.projectId).toBe(project.id);

    await tickReflection(gw.core, new Date(now.getTime() + 60_000));
    expect(prompts).toHaveLength(1);

    const rule = "After UI changes, capture a screenshot. Show it with show_images.";
    await gw.api.resolveMemoryHabit({ habitId: habit.id, expectedRevision: habit.revision, approve: true, rule });
    expect((await gw.api.getMemoryHabits({})).suggestions).toEqual([]);
    expect((await gw.api.listMemoryNotes({ scope: ui.MemoryNoteScope.PROJECT })).notes).toEqual([
      expect.objectContaining({ body: rule, projectId: project.id }),
    ]);

    const target = await newThread("Button alignment");
    await gw.api.sendMessage({ threadId: target.id, text: "Fix the button alignment in the UI." });
    await complete(target.id);
    await gw.api.sendMessage({ threadId: target.id, text: "Check the UI alignment again." });
    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((store) => store.turnsOf(target.id))),
      (turns) => turns.length === 2 && turns.every((turn) => turn.status === "completed"),
    );

    const commands = gw.worker.commands.flatMap((command) =>
      command.case === "startTurn" && command.value.thread?.threadId === target.id ? [command.value] : [],
    );

    expect(commands).toHaveLength(2);
    expect(commands[0]?.habitContext).toContain(rule);
    expect(commands[0]?.input?.text).toBe("Fix the button alignment in the UI.");
    expect(commands[1]?.habitContext).toBe("");

    const note = (await gw.api.listMemoryNotes({ scope: ui.MemoryNoteScope.PROJECT })).notes[0]!;

    await gw.api.deleteMemoryNote({ noteId: note.id, expectedRevision: note.revision });
    await gw.api.sendMessage({ threadId: target.id, text: "Review the UI once more." });
    await complete(target.id);

    const revocation = gw.worker.commands.findLast(
      (command) => command.case === "startTurn" && command.value.thread?.threadId === target.id,
    );

    expect(revocation?.case === "startTurn" && revocation.value.habitContext).toContain("block is revoked");
    expect(revocation?.case === "startTurn" && revocation.value.input?.text).toBe("Review the UI once more.");

    await gw.api.sendMessage({ threadId: target.id, text: "Check the new UI." });
    await complete(target.id);

    const subsequent = gw.worker.commands.findLast(
      (command) => command.case === "startTurn" && command.value.thread?.threadId === target.id,
    );

    expect(subsequent?.case === "startTurn" && subsequent.value.habitContext).toBe("");
    const afterDelete = await newThread("New menu");

    await gw.api.sendMessage({ threadId: afterDelete.id, text: "Fix the UI of the menu." });
    await complete(afterDelete.id);

    const deletedContext = gw.worker.commands.find(
      (command) => command.case === "startTurn" && command.value.thread?.threadId === afterDelete.id,
    );

    expect(deletedContext?.case === "startTurn" && deletedContext.value.habitContext).toBe("");
  }, 60_000);
});
