import { Provider, ui } from "@canopy/contracts";
import { toUiThread, turnEffort, type ThreadRow } from "../store/index.ts";
import { provisionalTitle, sanitizeTitle, titleContext, titleModel, titlePrompt } from "./thread-titles.ts";
import { providerOf } from "../store/instance-config.ts";
import { coreState, InvalidError, UnavailableError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { coreForPickers, coreModels } from "./core-models.ts";
import { coreWorkers } from "./core-providers.ts";
import { coreBroadcastThread, coreLog, coreRun } from "./core-broadcast.ts";
import { coreGoals } from "./core-goals.ts";
import { coreSettings } from "./core-settings.ts";

/** The UI's thread: the row plus what only this gateway knows (a title being generated right now). */
export function coreUiThread(hostContext: GatewayCore, row: ThreadRow): ui.Thread {
  const thread = toUiThread(row);
  thread.titleGenerating =
    hostContext[coreState].titleJobs.has(row.id) || hostContext[coreState].titlePreparing.has(row.id);

  return thread;
}

export function coreAutoTitle(hostContext: GatewayCore, threadId: string, context: string): void {
  if (hostContext[coreState].actions.defer(() => coreAutoTitle(hostContext, threadId, context))) return;
  // One atomic claim across duplicate requests and gateway processes. No outbox or reconnect retries.
  void coreRun(hostContext, (s) => s.beginTitle(threadId, true, context, provisionalTitle(context)))
    .then(async (row) => {
      if (!row) return;
      await coreBroadcastThread(hostContext, threadId);
      coreLaunchTitle(hostContext, row);
    })
    .catch(() => coreLog(hostContext, `thread title ${threadId}: could not prepare generation`));
}

export function coreLaunchTitle(hostContext: GatewayCore, thread: ThreadRow): void {
  if (hostContext[coreState].actions.defer(() => coreLaunchTitle(hostContext, thread))) return;

  const job = coreGenerateTitle(hostContext, thread)
    .catch(() => {
      // SDK/provider failures can contain auth or endpoints. Only a safe, bounded diagnostic is logged.
      coreLog(hostContext, `thread title ${thread.id}: generation unavailable, failed or timed out; title retained`);
    })
    .finally(() => {
      if (hostContext[coreState].titleJobs.get(thread.id) !== job) return;
      hostContext[coreState].titleJobs.delete(thread.id);
      void coreBroadcastThread(hostContext, thread.id).catch(() => {}); // the UI stops showing it as generating
    });

  hostContext[coreState].titleJobs.set(thread.id, job);
  void coreBroadcastThread(hostContext, thread.id).catch(() => {});
}

export async function coreGenerateTitle(hostContext: GatewayCore, thread: ThreadRow): Promise<void> {
  const text = await coreGenerateText(hostContext, thread, (settings) =>
    titlePrompt(thread.title_context, settings?.threadTitleInstructions),
  );

  const title = sanitizeTitle(text);

  if (!title) throw new Error("text generation returned an empty title");
  // The job's end broadcasts the thread: the new title and the end of "generating" arrive together.
  await coreRun(hostContext, (s) => s.finishTitle(thread.id, thread.title_revision, title));
}

/**
 * One generation for a thread (titles, branch names): the instance, model and effort of Settings → Text
 * generation, else a small model of the thread's instance; on the thread's worker when it can, else another
 * online worker with that instance.
 */
export async function coreGenerateText(
  hostContext: GatewayCore,
  thread: Pick<ThreadRow, "owner_user_id" | "provider" | "provider_profile_id" | "worker_id" | "settings">,
  prompt: (settings: ui.TextGenerationSettings | undefined) => string,
): Promise<string> {
  const settings = (await coreSettings(hostContext, (s) => s.user(thread.owner_user_id))).textGeneration;
  const explicit = !!settings?.model;
  const provider = explicit ? settings!.provider : providerOf(thread.provider);
  const profileId = (explicit ? settings!.profileId : thread.provider_profile_id) || "native";

  const workers = (await coreWorkers(hostContext)).filter(
    (w) =>
      hostContext.online.has(w.id) &&
      w.providerInstances.some((i) => i.harness === provider && i.id === profileId && i.enabled && i.available),
  );

  const worker = workers.find((w) => w.id === thread.worker_id) ?? workers[0];
  const connection = worker && hostContext.link.connections.get(worker.id);

  if (!connection) throw new UnavailableError("no worker for text generation");
  const catalog = (await coreForPickers(hostContext, await coreModels(hostContext, (s) => s.catalogs([worker.id]))))[0];
  const listed = catalog?.profiles.find((p) => p.provider === provider && p.profileId === profileId);

  const choice = explicit
    ? { model: settings!.model, effort: turnEffort(listed, settings!.model, settings!.effort) }
    : titleModel(listed, thread.settings.model ?? "");

  if (provider === Provider.GROK && !/^grok-3-mini(?:-fast)?$/.test(choice.model))
    throw new InvalidError("Choose grok-3-mini or grok-3-mini-fast for inexpensive Grok titles");

  const result = await connection.sendCommand(
    {
      case: "generateText",
      value: {
        provider,
        profileId,
        ...choice,
        prompt: prompt(settings),
      },
    },
    32_000,
  );

  if (!result.ok) throw new Error("text generation failed");

  return result.generatedText;
}

export interface CoreTitlesMethods {
  regenerateTitle(threadId: string): Promise<void>;
}

export const coreTitlesMethods: CoreTitlesMethods = {
  /** Shared hook for the thread panel, command palette and future sidebar context menu. */
  async regenerateTitle(this: GatewayCore, threadId: string): Promise<void> {
    const thread = await coreRun(this, (s) => s.thread(threadId));

    if (thread.owner_user_id !== this[coreState].options.userId || thread.archived_at)
      throw new InvalidError("thread not found");
    const first = thread.title_context ? undefined : await coreRun(this, (s) => s.titleInput(threadId));
    const goal = !thread.title_context && !first ? await coreGoals(this, (s) => s.latest(threadId)) : undefined;

    const context =
      thread.title_context ||
      (first &&
        titleContext({
          text: first.input.message ?? first.input.text ?? "",
          attachments: first.input.attachments,
          quotes: first.input.quotes,
        })) ||
      (goal && titleContext({ text: goal.objective }));

    if (!context) throw new InvalidError("send a message before generating a title");

    if (this[coreState].titleJobs.has(threadId) || this[coreState].titlePreparing.has(threadId))
      throw new UnavailableError("title generation is already running");
    this[coreState].titlePreparing.add(threadId);

    try {
      const row = await coreRun(this, (s) => s.beginTitle(threadId, false, context));

      if (row) coreLaunchTitle(this, row);
    } finally {
      this[coreState].titlePreparing.delete(threadId);
    }
  },
};
