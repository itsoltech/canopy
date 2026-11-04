/**
 * Live, through the whole stack: mentions (docs/ui-api.md, "Wzmianki"). A repository with a Claude project skill and
 * command, a Codex repo skill and a notes file; the catalogs each harness reports for it; a Claude turn invoking the
 * skill and one running the command; a file mention (does Claude Code expand "@path" itself?); a Codex turn with a
 * skill item and a file mention; a thread mention the agent follows with read_thread / get_thread.
 * Opt-in: CANOPY_LIVE=1 with the CLIProxyAPI env (docs/codex-adapter.md#testy-na-żywo).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, PermissionMode, Provider, type Mention } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { mentionPlaceholder } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { useLiveProxy } from "./support/live.ts";

const tempDir = tempDirs();

const LIVE = process.env["CANOPY_LIVE"] === "1";
const proxyUrl = process.env["CANOPY_LIVE_CLIPROXYAPI_URL"];
const proxyKey = process.env["CANOPY_LIVE_CLIPROXYAPI_KEY"];
const CODEX_MODEL = process.env["CANOPY_LIVE_CODEX_MODEL"] ?? "gpt-6.1-sol";
const CLAUDE_MODEL = process.env["CANOPY_LIVE_CLAUDE_MODEL"] ?? "claude-haiku-5-5";

type Part = string | { kind: MentionKind; name: string; label?: string; path?: string; source?: string };

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

describe.skipIf(!LIVE || !proxyUrl || !proxyKey || !dockerAvailable)("mentions with a real worker (live)", () => {
  let gw: TestGateway;
  let workerId = "";
  let workspaceId = "";
  let projectId = "";
  let stop = async () => {};

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );

  const answers = (threadId: string) =>
    query<{ text: string }>(
      "SELECT content->'agentMessage'->>'text' AS text FROM thread_items WHERE thread_id = $1::uuid AND type = 'agent_message' ORDER BY first_seq",
      threadId,
    );

  const waitFor = async (threadId: string, pattern: RegExp) => {
    const rows = await eventually(
      () => answers(threadId),
      (r) => r.some((x) => pattern.test(x.text ?? "")),
      300_000,
    );

    return rows.map((r) => r.text).join(" | ");
  };

  const toolsOf = (threadId: string) =>
    query<{ type: string; name: string | null }>(
      "SELECT type, coalesce(content->'toolCall'->>'name', content->'agentBusCall'->>'toolName') AS name FROM thread_items WHERE thread_id = $1::uuid AND type IN ('tool_call', 'agent_bus_call') ORDER BY first_seq",
      threadId,
    );

  const newThread = async (title: string, provider: Provider, first: { text: string; mentions: Mention[] }) =>
    (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title,
        provider,
        providerProfileId: "cliproxyapi",
        model: provider === Provider.CLAUDE ? CLAUDE_MODEL : CODEX_MODEL,
        permissionMode: PermissionMode.READ_ONLY,
        initialMessage: first.text,
        initialMentions: first.mentions,
      })
    ).thread!;

  beforeAll(async () => {
    gw = await startTestGateway();
    const repo = tempDir("canopy-live-mentions-repo-");
    const data = tempDir("canopy-live-mentions-worker-");

    const write = (path: string, content: string) => {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    };

    write(
      ".claude/skills/marker-skill/SKILL.md",
      "---\nname: marker-skill\ndescription: Answers with the project's marker\n---\nWhen this skill is used, end your reply with the line SKILL-MARKER-7731.\n",
    );
    write(
      ".claude/commands/stamp.md",
      "---\ndescription: Stamps a word\nargument-hint: <word>\n---\nReply with exactly: STAMP-4410 $ARGUMENTS\n",
    );
    write(
      ".agents/skills/codex-marker/SKILL.md",
      "---\nname: codex-marker\ndescription: Answers with the repository's Codex marker\n---\nWhen this skill is used, end your reply with the line CODEX-SKILL-5512.\n",
    );
    write("notes/plan.md", "# Plan\n\nThe secret fruit is MANGOSTEEN.\n");
    await Bun.$`git init -q && git add . && git -c user.email=t@t -c user.name=t commit -qm init`.cwd(repo);

    const added = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "live", ownerUserId: gw.userId })),
    );

    workerId = added.workerId;
    await useLiveProxy(gw, workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));
    const host = new WorkerHost({ runtime, dataDir: join(data, "data"), clientVersion: "live" });

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: added.credential,
      hello: {
        workerId,
        attachmentsRoot: host.attachmentsRoot,
        host: { os: process.platform },
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

    projectId = (await gw.api.createProject({ name: "Live mentions" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId, rootPath: repo, label: "live" })).workspace!.id;
    await eventually(
      () => gw.api.listModels({ workerId }),
      (r) => (r.workers[0]?.profiles.length ?? 0) >= 2,
      90_000,
    );
  }, 180_000);

  afterAll(async () => {
    await stop();
    await gw?.close();
  });

  test("catalogs: what Codex and Claude report for the repository; file search", async () => {
    const codex = (
      await gw.api.listMentionCatalog({
        scope: { workspaceId, provider: Provider.CODEX, providerProfileId: "cliproxyapi" },
      })
    ).catalog!;

    const claude = (
      await gw.api.listMentionCatalog({
        scope: { workspaceId, provider: Provider.CLAUDE, providerProfileId: "cliproxyapi" },
      })
    ).catalog!;

    const summary = (c: typeof codex) =>
      c.entries.map((e) => `${MentionKind[e.kind]}:${e.name}(${e.source}${e.icon ? ",icon" : ""})`).join(" ");

    console.info(`Codex catalog (${codex.entries.length}): ${summary(codex)}\n  notes: ${codex.notes.join("; ")}`);
    console.info(`Claude catalog (${claude.entries.length}): ${summary(claude)}\n  notes: ${claude.notes.join("; ")}`);

    const has = (c: typeof codex, kind: MentionKind, name: string, source?: string) =>
      c.entries.some((e) => e.kind === kind && e.name === name && (!source || e.source === source));

    expect(has(codex, MentionKind.COMMAND, "goal", "platform")).toBe(true);
    expect(has(codex, MentionKind.SKILL, "codex-marker", "project")).toBe(true);
    expect(codex.entries.some((e) => e.kind === MentionKind.SKILL && e.source === "system")).toBe(true);
    expect(has(claude, MentionKind.SKILL, "marker-skill", "project")).toBe(true);
    expect(has(claude, MentionKind.COMMAND, "stamp", "project")).toBe(true);
    expect(has(claude, MentionKind.COMMAND, "compact", "built-in")).toBe(true);
    expect(has(claude, MentionKind.COMMAND, "model")).toBe(false);
    const files = await gw.api.searchFiles({ scope: { workspaceId }, query: "plan" });
    expect(files.result?.matches[0]?.path).toBe("notes/plan.md");
  }, 120_000);

  test("Claude: a leading skill runs it; a command chip in the middle runs the command; a file mention", async () => {
    const skill = await newThread(
      "Claude skill",
      Provider.CLAUDE,
      message({ kind: MentionKind.SKILL, name: "marker-skill", source: "project" }, " Say hi in one short sentence."),
    );

    console.info(`Claude skill: ${await waitFor(skill.id, /SKILL-MARKER-7731/)}`);

    const command = await newThread(
      "Claude command",
      Provider.CLAUDE,
      message("pelican ", { kind: MentionKind.COMMAND, name: "stamp", source: "project" }),
    );

    console.info(`Claude command: ${await waitFor(command.id, /STAMP-4410\s+pelican/i)}`);

    const file = await newThread(
      "Claude file",
      Provider.CLAUDE,
      message(
        "What is the secret fruit in ",
        { kind: MentionKind.FILE, name: "notes/plan.md" },
        "? Answer with one word.",
      ),
    );

    console.info(
      `Claude file: ${await waitFor(file.id, /MANGOSTEEN/i)}; tools: ${(await toolsOf(file.id)).map((t) => t.name).join(", ") || "none (Claude Code expanded @path itself)"}`,
    );
  }, 900_000);

  test("Codex: a skill item and a file mention", async () => {
    // The skill as the composer picks it: with its SKILL.md path from the catalog (the Codex skill item needs it).
    const catalog = (
      await gw.api.listMentionCatalog({
        scope: { workspaceId, provider: Provider.CODEX, providerProfileId: "cliproxyapi" },
      })
    ).catalog!;

    const skill = catalog.entries.find((e) => e.name === "codex-marker")!;

    const thread = await newThread(
      "Codex skill and file",
      Provider.CODEX,
      message(
        "Use ",
        { kind: MentionKind.SKILL, name: skill.name, source: skill.source, path: skill.path },
        " and tell me the secret fruit in ",
        { kind: MentionKind.FILE, name: "notes/plan.md" },
        ". One line.",
      ),
    );

    const answer = await waitFor(thread.id, /CODEX-SKILL-5512/);
    console.info(`Codex: ${answer}`);
    expect(answer).toMatch(/MANGOSTEEN/i);
  }, 600_000);

  test("a thread mention: the agent reads the other thread over the agent bus", async () => {
    const source = await newThread("Bird of the day", Provider.CODEX, {
      text: "Reply with exactly this sentence and nothing else: The password is OSPREY-61.",
      mentions: [],
    });

    await waitFor(source.id, /OSPREY-61/);

    const reader = await newThread(
      "Reader",
      Provider.CLAUDE,
      message(
        "What password does the thread ",
        { kind: MentionKind.THREAD, name: source.id, label: "Bird of the day" },
        " give? Read it, then answer with the password only.",
      ),
    );

    console.info(`Thread mention: ${await waitFor(reader.id, /OSPREY-61/)}`);
    const tools = await toolsOf(reader.id);
    console.info(`Reader tools: ${tools.map((t) => t.name).join(", ")}`);
    expect(tools.some((t) => /read_thread|get_thread/.test(t.name ?? ""))).toBe(true);
  }, 600_000);
});
