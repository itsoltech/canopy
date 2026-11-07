import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { coreRun } from "../core/core-broadcast.ts";
import { coreState, InvalidError } from "../core/core-context.ts";
import { providerOf } from "../store/instance-config.ts";
import type { CliImports } from "./index.ts";

/**
 * Seeded continue (docs/import.md, "Kontynuacja"): a new thread in the imported thread's place whose agent starts
 * with a note built from the imported history, the way a moved thread does (settings.handoff becomes part of the new
 * session's instructions). No model is called to write it.
 */

const NAMES = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["grok", "Grok"],
]);

const BUDGET = 24_000;
const PER_MESSAGE = 2_000;

interface TurnRow {
  readonly ordinal: number;
  readonly prompt: string | null;
  readonly answer: string | null;
}

export async function continueImportedThread(imports: CliImports, threadId: string): Promise<ui.GetThreadResponse> {
  const core = imports.core;
  const thread = await coreRun(core, (s) => s.thread(threadId));

  if (thread.owner_user_id !== core[coreState].options.userId || !thread.imported || thread.deleted_at)
    throw new InvalidError("Imported thread not found");

  const [turns, files] = await imports.sql((sql) =>
    Effect.all([
      sql<TurnRow>`
        SELECT u.ordinal, u.input->>'text' AS prompt,
               (SELECT m.content->'agentMessage'->>'text' FROM thread_items m
                 WHERE m.thread_id = u.thread_id AND m.turn_id = u.id AND m.type = 'agent_message' AND m.parent_item_id IS NULL
                 ORDER BY m.last_seq DESC LIMIT 1) AS answer
          FROM turns u WHERE u.thread_id = ${threadId}::uuid ORDER BY u.ordinal`,
      sql<{ path: string }>`
        SELECT DISTINCT c->>'path' AS path FROM thread_items i, jsonb_array_elements(i.content->'fileChange'->'changes') c
         WHERE i.thread_id = ${threadId}::uuid AND i.type = 'file_change' LIMIT 60`,
    ]),
  );

  const note = importHandoffNote(
    { title: thread.title, agentCli: thread.imported.agent_cli, cwd: thread.cwd ?? "" },
    turns,
    files.map((f) => f.path),
  );

  return create(ui.GetThreadResponseSchema, { thread: await createContinuation(imports, thread, note) });
}

export function importHandoffNote(
  source: { title: string; agentCli: string; cwd: string },
  turns: readonly TurnRow[],
  files: readonly string[],
): string {
  const cli = NAMES.get(source.agentCli) ?? source.agentCli;
  const lines: string[] = [];
  let size = 0;
  let left = 0;

  for (const turn of [...turns].reverse()) {
    const cut = (text: string | null) => {
      const value = (text ?? "").trim();

      return value.length > PER_MESSAGE ? `${value.slice(0, PER_MESSAGE)}…` : value;
    };

    const block = [`User: ${cut(turn.prompt)}`, ...(turn.answer ? [`Assistant: ${cut(turn.answer)}`] : [])].join("\n");

    if (size + block.length > BUDGET) {
      left += 1;
      continue;
    }

    lines.unshift(block);
    size += block.length;
  }

  return [
    `Handoff: this thread continues earlier work imported from ${cli} ("${source.title}", ${turns.length} turns, in ${source.cwd}).`,
    "That session is not resumed here; this is an excerpt of its messages, not the full history.",
    ...(left > 0 ? [`(${left} earlier turns are left out.)`] : []),
    ...lines,
    ...(files.length > 0 ? [`Files it changed: ${files.join(", ")}`] : []),
    "Check the files before relying on earlier output. Continue naturally; mention the import only if the user asks.",
  ].join("\n\n");
}

export async function createContinuation(
  imports: CliImports,
  thread: {
    project_id: string;
    workspace_id: string | null;
    provider: string;
    cwd: string | null;
    title: string;
    project_kind?: string;
  },
  note: string,
): Promise<ui.Thread> {
  const created = await imports.core.createThread(
    create(ui.CreateThreadRequestSchema, {
      projectId: thread.project_id,
      workspaceId: thread.workspace_id ?? "",
      provider: providerOf(thread.provider),
      ...(thread.project_kind !== "scratch" && thread.cwd && { cwd: thread.cwd }),
      title: `${thread.title} (continued)`.slice(0, 200),
    }),
  );

  // Read by ThreadSpec.instructions of the new session, like a moved thread's note.
  await imports.sql(
    (sql) =>
      sql`UPDATE threads SET settings = settings || ${JSON.stringify({ handoff: note })}::jsonb WHERE id = ${created.id}::uuid`,
  );

  return created;
}
