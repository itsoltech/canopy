import { create } from "@bufbuild/protobuf";
import {
  MentionCatalogSchema,
  MentionKind,
  MentionSchema,
  Provider,
  ui,
  type CommandResult,
  type CloneProgress,
  type Mention,
  type MentionCatalog,
} from "@canopy/contracts";
import { type CommandInit } from "../worker-link/index.ts";
import {
  checkMentions,
  composeMessage,
  joinNotes,
  MentionError,
  numberAttachmentMarkers,
  quotesNote,
} from "@canopy/domain";
import { isPlatformCommand, mentionsToJson, PLATFORM_COMMANDS, workerPath } from "./mentions.ts";
import type { StoredQuote } from "../store/quotes.ts";
import { withQuotes } from "./quotes.ts";
import { providerOf } from "../store/instance-config.ts";
import { CATALOG_TTL_MS, coreState, InvalidError, UnavailableError, type TurnInputJson } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreUiThread } from "./core-titles.ts";
import type { PlacedFile } from "./core-attachments.ts";
import { coreRun } from "./core-broadcast.ts";

/** Worker, provider, profile and folder of a thread, or of a new thread in a workspace. */
export async function coreMentionScope(
  hostContext: GatewayCore,
  scope: ui.MentionScope | undefined,
): Promise<{ workerId: string; provider: Provider; profileId: string; cwd: string; scratchDraft?: boolean }> {
  if (scope?.threadId) {
    const thread = await coreRun(hostContext, (s) => s.thread(scope.threadId));

    if (thread.owner_user_id !== hostContext[coreState].options.userId) throw new InvalidError("thread not found");

    if (!thread.worker_id || thread.runtime !== "worker") throw new InvalidError("this thread has no worker");

    return {
      workerId: thread.worker_id,
      provider: providerOf(thread.provider),
      profileId: thread.provider_profile_id || "native",
      cwd: thread.cwd ?? "",
    };
  }

  const projects = await coreRun(hostContext, (s) => s.listProjects(hostContext[coreState].options.userId));
  const workspace = projects.flatMap((p) => p.workspaces).find((w) => w.id === scope?.workspaceId);

  if (!workspace) throw new InvalidError("workspace not found");
  const scratchDraft = projects.find((p) => p.id === workspace.projectId)?.kind === "scratch";

  // Before creation, list the machine's commands/skills from its home. File search
  // remains empty; after creation both catalogs and files use the thread's exact scratch cwd.
  const root = scratchDraft
    ? (await coreWorkers(hostContext)).find((w) => w.id === workspace.workerId)?.homeDirectory
    : undefined;

  return {
    workerId: workspace.workerId,
    provider: scope?.provider || Provider.CODEX,
    profileId: scope?.providerProfileId || "native",
    cwd: scratchDraft ? root || "" : scope?.cwd || workspace.rootPath,
    scratchDraft,
  };
}

/** A read-only command to an online worker; offline = Unavailable with a message the popup shows. */
export async function coreWorkerQuery(
  hostContext: GatewayCore,
  workerId: string,
  kind: CommandInit,
  timeoutMs: number,
  options?: { commandId: string; progress: (progress: CloneProgress) => void },
): Promise<CommandResult> {
  const connection = hostContext.link.connections.get(workerId);

  if (!connection?.isOpen) {
    const worker = (await coreRun(hostContext, (s) => s.listWorkers(hostContext.online))).find(
      (w) => w.id === workerId,
    );

    throw new UnavailableError(`${worker?.name || "the worker"} is offline`);
  }

  const result = await connection.sendCommand(kind, timeoutMs, options?.commandId, options?.progress);

  if (!result.ok) {
    if (kind.case === "cloneRepository" && result.errorCode === "CLONE_AUTH_FAILED") {
      const worker = (await coreWorkers(hostContext)).find((w) => w.id === workerId);
      throw new InvalidError(
        `Sign in to Git on ${worker?.name || "the worker"} (SSH key or credential helper), then retry.`,
      );
    }

    throw new InvalidError(result.errorMessage || result.errorCode);
  }

  return result;
}

/**
 * A user's message with mentions: checked against the text, files resolved to their path on the worker, threads
 * to the user's own (their title as the label), placed attachments to the message's own files (`attachments`: by
 * id, the stored name as the badge's label and the kind, image or file, as its source; each placed once). A platform command (/goal) is returned apart: the rest of the
 * text is its argument.
 */
export async function coreMessageMentions(
  hostContext: GatewayCore,
  thread: { id?: string; cwd: string },
  text: string,
  mentions: readonly Mention[],
  attachments: ReadonlyMap<string, PlacedFile> = new Map(),
): Promise<{ mentions: Mention[]; goal?: string }> {
  if (mentions.length === 0) return { mentions: [] };
  let checked: Mention[];

  try {
    checked = checkMentions(text, mentions);
  } catch (error) {
    if (error instanceof MentionError) throw new InvalidError(error.message);
    throw error;
  }

  const command = checked.find(isPlatformCommand);

  if (command) {
    if (command.name !== "goal") throw new InvalidError(`unknown platform command /${command.name}`);

    return {
      mentions: [],
      goal: `${text.slice(0, command.start)}${text.slice(command.end)}`.replace(/\s+/g, " ").trim(),
    };
  }

  const resolved: Mention[] = [];
  const placed = new Set<string>();

  for (const m of checked) {
    if (m.kind === MentionKind.BOT) throw new InvalidError("bot mentions are supported in bot conversations only");

    if (m.kind === MentionKind.ATTACHMENT) {
      const file = attachments.get(m.name);

      if (!file) throw new InvalidError("a file placed in the message is not attached to it");

      if (placed.has(m.name)) throw new InvalidError("a file is placed in the message more than once");
      placed.add(m.name);
      resolved.push(create(MentionSchema, { ...m, label: file.name, source: file.kind, path: "" }));
      continue;
    }

    if (m.kind === MentionKind.FILE) {
      resolved.push(create(MentionSchema, { ...m, path: workerPath(thread.cwd, m.name) }));
    } else if (m.kind === MentionKind.THREAD) {
      const target = await coreRun(hostContext, (s) => s.thread(m.name)).catch(() => undefined);

      if (!target || target.owner_user_id !== hostContext[coreState].options.userId || target.id === thread.id)
        throw new InvalidError("a mentioned thread was not found");
      resolved.push(create(MentionSchema, { ...m, label: target.title || "Untitled" }));
    } else {
      resolved.push(m);
    }
  }

  return { mentions: resolved };
}

/**
 * The turn (or steer) input of a message with mentions: composed for the provider after the other notes. Placed
 * attachments become "[Attachment N: name]" in the delivered text (N: the line of the note, `base.attachments`).
 */
export function coreComposeInput(
  hostContext: GatewayCore,
  provider: string,
  message: string,
  mentions: readonly Mention[],
  base: TurnInputJson | undefined,
  quotes: readonly StoredQuote[] = [],
): TurnInputJson | undefined {
  if (mentions.length === 0) return quotes.length > 0 ? withQuotes(base ?? { text: message, message }, quotes) : base;
  // The quotes' note joins the other notes before the message, so the mentions' ranges shift past it too.
  const note = joinNotes(base?.note ?? "", quotesNote(quotes));

  const numbered = numberAttachmentMarkers(
    message,
    mentions,
    (base?.attachments ?? []).map((a) => a.id),
  );

  const composed = composeMessage(providerOf(provider), numbered.message, numbered.mentions, note ? [note] : []);

  return {
    ...base,
    text: composed.text,
    note: composed.note,
    message,
    mentions: mentionsToJson(mentions),
    delivered: mentionsToJson(composed.mentions),
    ...(quotes.length > 0 && { quotes: [...quotes] }),
  };
}

const catalogPending = new WeakMap<GatewayCore, Map<string, Promise<MentionCatalog>>>();

/** Catalog queries in flight, per owner core and scope. */
function catalogReads(core: GatewayCore): Map<string, Promise<MentionCatalog>> {
  let reads = catalogPending.get(core);

  if (!reads) catalogPending.set(core, (reads = new Map()));

  return reads;
}

export interface CoreMentionsMethods {
  listMentionCatalog(request: ui.ListMentionCatalogRequest): Promise<ui.ListMentionCatalogResponse>;
  searchFiles(request: ui.SearchFilesRequest): Promise<ui.SearchFilesResponse>;
  searchThreads(request: ui.SearchThreadsRequest): Promise<ui.SearchThreadsResponse>;
}

export const coreMentionsMethods: CoreMentionsMethods = {
  // ------------------------------------------------------------------ mentions (docs/ui-api.md, "Wzmianki")

  /** Commands, skills and plugins of the scope's provider (worker, cached CATALOG_TTL_MS), the platform's commands first. */
  async listMentionCatalog(
    this: GatewayCore,
    request: ui.ListMentionCatalogRequest,
  ): Promise<ui.ListMentionCatalogResponse> {
    const scope = await coreMentionScope(this, request.scope);
    const key = `${scope.workerId}|${scope.provider}|${scope.profileId}|${scope.cwd}`;
    const cached = this[coreState].catalogs.get(key);
    let catalog = !request.refresh && cached && Date.now() - cached.at < CATALOG_TTL_MS ? cached.catalog : undefined;

    if (!catalog) {
      // Composers asking for the same scope at once share one worker query.
      const pending = catalogReads(this);
      const shared = !request.refresh && pending.get(key);

      const read =
        shared ||
        coreWorkerQuery(
          this,
          scope.workerId,
          {
            case: "listMentionCatalog",
            value: { provider: scope.provider, profileId: scope.profileId, cwd: scope.cwd, refresh: request.refresh },
          },
          45_000,
        ).then((result) => {
          const value =
            result.mentionCatalog ??
            create(MentionCatalogSchema, { provider: scope.provider, profileId: scope.profileId, cwd: scope.cwd });

          this[coreState].catalogs.set(key, { at: Date.now(), catalog: value });

          if (this[coreState].catalogs.size > 200)
            this[coreState].catalogs.delete(this[coreState].catalogs.keys().next().value ?? "");

          return value;
        });

      if (!shared) {
        pending.set(key, read);
        void read.catch(() => {}).finally(() => pending.get(key) === read && pending.delete(key));
      }

      catalog = await read;
    }

    // Goals need a worker thread of either provider; the platform runs /goal itself (SetGoal).
    const entries = [
      ...PLATFORM_COMMANDS,
      ...catalog.entries.filter((e) => !PLATFORM_COMMANDS.some((p) => p.kind === e.kind && p.name === e.name)),
    ];

    return create(ui.ListMentionCatalogResponseSchema, { catalog: { ...catalog, entries } });
  },

  /** Fuzzy file search in the scope's folder on its worker. */
  async searchFiles(this: GatewayCore, request: ui.SearchFilesRequest): Promise<ui.SearchFilesResponse> {
    const scope = await coreMentionScope(this, request.scope);

    // The draft's fresh directory has no files and does not exist until CreateThread.
    if (scope.scratchDraft) return create(ui.SearchFilesResponseSchema, { result: { matches: [], source: "walk" } });

    const result = await coreWorkerQuery(
      this,
      scope.workerId,
      { case: "searchFiles", value: { cwd: scope.cwd, query: request.query, limit: request.limit } },
      20_000,
    );

    return create(ui.SearchFilesResponseSchema, { ...(result.fileSearch && { result: result.fileSearch }) });
  },

  /** The user's threads by title (fuzzy), best match first, the most recent activity first among equals. */
  async searchThreads(this: GatewayCore, request: ui.SearchThreadsRequest): Promise<ui.SearchThreadsResponse> {
    const limit = Math.min(request.limit || 20, 50);

    const rows = await coreRun(this, (s) =>
      s.searchThreads(this[coreState].options.userId, request.query, request.excludeThreadId, limit),
    );

    return create(ui.SearchThreadsResponseSchema, { threads: rows.map((row) => coreUiThread(this, row)) });
  },
};
