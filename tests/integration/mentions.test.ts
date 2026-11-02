/**
 * Mentions end to end on PostgreSQL (docs/ui-api.md, "Wzmianki"): the composer's catalog, file and thread search
 * through the gateway to a scripted worker; a message with mentions checked, resolved and composed per provider
 * (StartTurn input with ranges, the turn keeps the chips); /goal as the platform's command; a mentioned thread is
 * readable over the agent bus from another tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { Client } from "@connectrpc/connect";
import { MentionKind, MentionSchema, Provider, ui, type Mention } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { mentionPlaceholder, quotesNote } from "@open-agents/domain";
import { eventually, failure, startTestGateway, type ScriptedWorker, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let api: Client<typeof ui.GatewayService>;
let worker: ScriptedWorker;

type Part = string | { kind: MentionKind; name: string; label?: string; path?: string; source?: string };

/** A message and its mentions from parts (objects become placeholders, like the composer inserts them). */
function message(...parts: Part[]): { text: string; mentions: Mention[] } {
  let text = "";
  const mentions: Mention[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    const placeholder = mentionPlaceholder({ kind: part.kind, name: part.name, label: part.label ?? "" });
    mentions.push(create(MentionSchema, { ...part, start: text.length, end: text.length + placeholder.length }));
    text += placeholder;
  }
  return { text, mentions };
}

const slices = (text: string, mentions: readonly Mention[]) => mentions.map((m) => text.slice(m.start, m.end));

describe.skipIf(!dockerAvailable)("mentions", () => {
  let projectId = "";
  let workspaceId = "";
  let claudeWorkspaceId = "";
  let claudeWorker: ScriptedWorker;

  beforeAll(async () => {
    gw = await startTestGateway();
    ({ api, worker } = gw);
    const workerId = (await api.getOverview({})).workers[0]!.id;
    projectId = (await api.createProject({ name: "Mentions" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo/app", label: "laptop" })).workspace!.id;
    const pc = await gw.addWorker("pc", ["/srv"]);
    claudeWorker = await gw.connect(pc.workerId, pc.credential, undefined, { claude: true });
    claudeWorkspaceId = (await api.createWorkspace({ projectId, workerId: pc.workerId, rootPath: "/srv/app", label: "pc" })).workspace!.id;
    await eventually(() => api.getOverview({}), (o) => o.workers.every((w) => w.online && w.appliedVersion > 0n));
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
  });

  const newThread = async (title: string, provider = Provider.CODEX) => {
    const thread = (await api.createThread({ projectId, workspaceId: provider === Provider.CLAUDE ? claudeWorkspaceId : workspaceId, title, provider })).thread!;
    await eventually(() => api.getThread({ threadId: thread.id }), (r) => r.thread?.status === "idle");
    return thread;
  };

  describe("catalog, files and threads for the popup", () => {
    test("the worker's catalog with the platform's /goal first, cached until refresh", async () => {
      const asked: { provider: Provider; profileId: string; cwd: string; refresh: boolean }[] = [];
      worker.handlers.set("listMentionCatalog", (value, reply) => {
        const v = value as (typeof asked)[number];
        asked.push({ provider: v.provider, profileId: v.profileId, cwd: v.cwd, refresh: v.refresh });
        reply(true, {
          mentionCatalog: {
            provider: v.provider,
            profileId: v.profileId,
            cwd: v.cwd,
            entries: [{ kind: MentionKind.SKILL, name: "imagegen", label: "Image Gen", source: "system", path: "/h/imagegen/SKILL.md" }],
            notes: ["commands: none"],
          },
        });
      });
      const thread = await newThread("Catalog");
      const first = await api.listMentionCatalog({ scope: { threadId: thread.id } });
      expect(first.catalog?.entries.map((e) => [e.kind, e.name, e.source])).toEqual([
        [MentionKind.COMMAND, "goal", "platform"],
        [MentionKind.SKILL, "imagegen", "system"],
      ]);
      await api.listMentionCatalog({ scope: { threadId: thread.id } });
      expect(asked).toEqual([{ provider: Provider.CODEX, profileId: "native", cwd: "/repo/app", refresh: false }]);
      await api.listMentionCatalog({ scope: { threadId: thread.id }, refresh: true });
      // A new thread's composer: the workspace's folder, the chosen provider.
      await api.listMentionCatalog({ scope: { workspaceId, provider: Provider.CODEX, cwd: "/repo/app/sub" } });
      expect(asked.slice(1).map((a) => [a.cwd, a.refresh])).toEqual([
        ["/repo/app", true],
        ["/repo/app/sub", false],
      ]);
      worker.handlers.delete("listMentionCatalog");
    });

    test("file search goes to the thread's folder on its worker", async () => {
      let seen: unknown;
      worker.handlers.set("searchFiles", (value, reply) => {
        seen = value;
        reply(true, { fileSearch: { matches: [{ path: "docs/notatka-z-lekcji.md", indices: [5, 6] }], source: "git" } });
      });
      const thread = await newThread("Files");
      const found = await api.searchFiles({ scope: { threadId: thread.id }, query: "notatka", limit: 10 });
      expect(found.result?.matches.map((m) => m.path)).toEqual(["docs/notatka-z-lekcji.md"]);
      expect(seen).toMatchObject({ cwd: "/repo/app", query: "notatka", limit: 10 });
      worker.handlers.delete("searchFiles");
    });

    test("an offline worker: Unavailable with its name for the popup", async () => {
      const spare = await gw.addWorker("spare", ["/x"]);
      const ws = (await api.createWorkspace({ projectId, workerId: spare.workerId, rootPath: "/x/app", label: "spare" })).workspace!;
      expect(await failure(api.searchFiles({ scope: { workspaceId: ws.id }, query: "a" }))).toContain("spare is offline");
    });

    test("threads by title, best match first, without the current one", async () => {
      const a = await newThread("Uwzględnij 3 zadania Pauli");
      const b = await newThread("Zadania na jutro");
      const found = await api.searchThreads({ query: "zadania", excludeThreadId: b.id });
      expect(found.threads.map((t) => t.id)).toContain(a.id);
      expect(found.threads.map((t) => t.id)).not.toContain(b.id);
      expect((await api.searchThreads({ query: "pauli" })).threads[0]?.id).toBe(a.id);
    });
  });

  describe("a message with mentions", () => {
    test("Codex: files resolved on the worker, the thread note first, ranges in the delivered text, chips on the turn", async () => {
      const other = await newThread("Plan sprintu");
      const thread = await newThread("Codex mentions");
      const { text, mentions } = message(
        "Użyj ",
        { kind: MentionKind.SKILL, name: "imagegen", label: "Image Gen", path: "/h/imagegen/SKILL.md", source: "system" },
        " do ",
        { kind: MentionKind.FILE, name: "docs/notatka.md" },
        " i ",
        { kind: MentionKind.THREAD, name: other.id, label: "stary tytuł" },
      );
      const { turn } = await api.sendMessage({ threadId: thread.id, text, mentions, clientRequestId: "m1" });
      await eventually(async () => worker.started.get(turn!.id), (input) => input !== undefined);
      const input = worker.started.get(turn!.id)!;
      expect(input.text.startsWith(`[open-agents] The user mentioned another thread; read it with get_thread / read_thread when you need it:\n- "Plan sprintu" (thread_id: ${other.id})\n\n`)).toBe(true);
      expect(slices(input.text, input.mentions)).toEqual(["$imagegen", "@docs/notatka.md", "#stary tytuł"]);
      expect(input.mentions[1]?.path).toBe("/repo/app/docs/notatka.md");
      // The chat shows the message as written, with its chips (the title as the gateway knows it).
      expect(turn!.messageText).toBe(text);
      expect(slices(turn!.messageText, turn!.mentions)).toEqual(["$imagegen", "@docs/notatka.md", "#stary tytuł"]);
      expect(turn!.mentions[2]?.label).toBe("Plan sprintu");
      expect(turn!.platformNote).toContain(other.id);
    });

    test("with quotes: the quotes' note joins the mention notes, the ranges shift past both, the turn keeps both", async () => {
      const other = await newThread("Notatki");
      const thread = await newThread("Mentions and quotes");
      const { text, mentions } = message("Porównaj z ", { kind: MentionKind.THREAD, name: other.id, label: "Notatki" }, ".");
      const quote = { text: "FAIL a.test.ts", comment: "Dlaczego?", sourceItemId: "item-q", sourceKind: "command_output" };
      const { turn } = await api.sendMessage({ threadId: thread.id, text, mentions, clientRequestId: "mq1", quotes: [quote] });
      await eventually(async () => worker.started.get(turn!.id), (input) => input !== undefined);
      const input = worker.started.get(turn!.id)!;
      expect(input.text).toContain(quotesNote([quote]));
      expect(input.text.endsWith(`\n\n${text}`)).toBe(true);
      expect(slices(input.text, input.mentions)).toEqual(["#Notatki"]);
      expect([turn!.messageText, turn!.quotes.map((q) => q.comment), slices(turn!.messageText, turn!.mentions)]).toEqual([text, ["Dlaczego?"], ["#Notatki"]]);
    });

    test("Claude: a command in the middle runs first; skills and files get notes", async () => {
      const thread = await newThread("Claude mentions", Provider.CLAUDE);
      const { text, mentions } = message(
        "please ",
        { kind: MentionKind.COMMAND, name: "review", source: "built-in" },
        " with ",
        { kind: MentionKind.SKILL, name: "design", source: "project" },
        " on ",
        { kind: MentionKind.FILE, name: "src" },
      );
      const { turn } = await api.sendMessage({ threadId: thread.id, text, mentions, clientRequestId: "c1" });
      await eventually(async () => claudeWorker.started.get(turn!.id), (input) => input !== undefined);
      const input = claudeWorker.started.get(turn!.id)!;
      const [note, delivered] = input.text.split("\n\n");
      expect(delivered).toBe("/review please with $design on @src");
      expect(note).toBe(
        "[open-agents] The user picked a skill for this message; use it with the Skill tool: design\n" +
          "[open-agents] The user mentioned a path in this thread's folder:\n- /srv/app/src",
      );
      expect(slices(input.text, input.mentions)).toEqual(["/review", "$design", "@src"]);
    });

    test("/goal is the platform's: the rest is the objective, no turn on Codex", async () => {
      const thread = await newThread("Goal");
      const { text, mentions } = message({ kind: MentionKind.COMMAND, name: "goal", source: "platform" }, " all tests pass");
      const before = worker.commands.length;
      const response = await api.sendMessage({ threadId: thread.id, text, mentions, clientRequestId: "g1" });
      expect(response.turn).toBeUndefined();
      expect(response.goal).toMatchObject({ objective: "all tests pass", status: "active" });
      await eventually(async () => worker.commands.slice(before), (c) => c.some((k) => k.case === "setGoal"));
      expect(worker.commands.slice(before).some((k) => k.case === "startTurn")).toBe(false);
    });

    test("a new thread's first message carries its mentions", async () => {
      const { text, mentions } = message("look at ", { kind: MentionKind.FILE, name: "README.md" });
      const thread = (await api.createThread({ projectId, workspaceId, title: "First", provider: Provider.CODEX, initialMessage: text, initialMentions: mentions })).thread!;
      const input = await eventually(async () => [...worker.started.values()].find((i) => i.text === text), (i) => i !== undefined);
      expect(input!.mentions[0]).toMatchObject({ kind: MentionKind.FILE, path: "/repo/app/README.md" });
      expect(thread.id).toBeTruthy();
    });

    test("refused: a path leaving the folder, a range off its placeholder, someone else's or an unknown thread", async () => {
      const thread = await newThread("Refusals");
      const escape = message("x ", { kind: MentionKind.FILE, name: "../secrets" });
      expect(await failure(api.sendMessage({ threadId: thread.id, ...escape }))).toContain("not a path inside the thread's folder");
      const moved = message("x ", { kind: MentionKind.SKILL, name: "s" });
      moved.mentions[0]!.start -= 1;
      expect(await failure(api.sendMessage({ threadId: thread.id, ...moved }))).toContain("does not start with $");
      const unknown = message("x ", { kind: MentionKind.THREAD, name: "0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", label: "?" });
      expect(await failure(api.sendMessage({ threadId: thread.id, ...unknown }))).toContain("mentioned thread was not found");
    });
  });

  describe("agent bus", () => {
    test("a mentioned thread of another tree can be read and messaged, like any thread of the same owner", async () => {
      const other = await newThread("Mentioned");
      const unrelated = await newThread("Not mentioned");
      const thread = await newThread("Reader");
      const { text, mentions } = message("see ", { kind: MentionKind.THREAD, name: other.id, label: "Mentioned" });
      const { turn } = await api.sendMessage({ threadId: thread.id, text, mentions, clientRequestId: "b1" });
      await eventually(async () => worker.started.get(turn!.id), (input) => input !== undefined);
      const read = await worker.callTool({ threadId: thread.id, turnId: turn!.id, tool: "get_thread", args: { thread_id: other.id } });
      expect(read.isError).toBe(false);
      const transcript = await worker.callTool({ threadId: thread.id, turnId: turn!.id, tool: "read_thread", args: { thread_id: other.id } });
      expect(transcript.isError).toBe(false);
      // The mention points the agent at it; the owner's other threads are as reachable (docs/agent-bus.md, section 6).
      const unmentioned = await worker.callTool({ threadId: thread.id, turnId: turn!.id, tool: "get_thread", args: { thread_id: unrelated.id } });
      expect(unmentioned.isError).toBe(false);
      const sent = await worker.callTool({ threadId: thread.id, turnId: turn!.id, tool: "send_message", args: { thread_id: other.id, prompt: "hi", notify: false } });
      expect(sent.isError).toBe(false);
      // Control stays with the thread's own descendants.
      const interrupt = await worker.callTool({ threadId: thread.id, turnId: turn!.id, tool: "interrupt_thread", args: { thread_id: other.id } });
      expect(interrupt.isError).toBe(true);
    });
  });
});
