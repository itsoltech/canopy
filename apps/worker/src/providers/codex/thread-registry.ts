import type { Mention } from "@canopy/contracts";
import { Semaphore } from "effect";
import type { ThreadEventInit } from "../../journal/index.ts";
import { CodexEventMapper } from "./mapping.ts";
import { RolloutTail } from "./rollout.ts";

import type { Entry, CodexThreadContext } from "./thread-types.ts";

export function registerThread(
  ctx: CodexThreadContext,
  platformId: string,
  codexId: string,
  rolloutPath: string | null,
): Entry {
  const { byPlatform, byCodex } = ctx;
  const pendingTurns: string[] = [];
  const codexToPlatform = new Map<string, string>();
  const platformToCodex = new Map<string, string>();
  const commandTurns = new Set<string>();
  const interrupting = new Set<string>();

  const bind = (codexTurn: string, platformTurn: string) => {
    codexToPlatform.set(codexTurn, platformTurn);
    platformToCodex.set(platformTurn, codexTurn);
  };

  const mapper = new CodexEventMapper({
    turnId: (codexTurn) => codexToPlatform.get(codexTurn),
    startTurn: (codexTurn) => {
      const known = codexToPlatform.get(codexTurn);

      if (known) return known;
      const providerTurn = Bun.randomUUIDv7(); // e.g. goal continuation started by Codex
      bind(codexTurn, providerTurn);

      return providerTurn;
    },
    isCommandTurn: (codexTurn) => commandTurns.has(codexTurn),
    interruptRequested: (codexTurn) => interrupting.has(codexTurn),
  });

  const rollout = rolloutPath ? { tail: new RolloutTail(rolloutPath), ended: new Set<string>() } : undefined;

  const entry: Entry = {
    platformId,
    codexId,
    mapper,
    pendingTurns,
    pendingNotifications: [],
    recording: Semaphore.makeUnsafe(1),
    recordingNotifications: false,
    warnedLateTurns: new Set(),
    codexToPlatform,
    platformToCodex,
    commandTurns,
    rollout,
    finishedTurns: new Set(),
    steered: new Set(),
    mentions: new Map(),
    interrupting,
    rolloutPath,
  };

  byPlatform.set(platformId, entry);
  byCodex.set(codexId, entry);

  return entry;
}

/**
 * Codex echoes the input as a userMessage item with the platform's client id; the transcript keeps its mentions so the
 * UI shows them as chips. The echo's text is the input text the ranges point into: Codex joins split text parts
 * (placed images between them) with line breaks, so the text as sent replaces it.
 */
export function withUserMentions(
  init: ThreadEventInit,
  mentions: ReadonlyMap<string, { readonly text: string; readonly mentions: readonly Mention[] }>,
): ThreadEventInit {
  const body = init.body;

  if (body?.case !== "itemStarted" && body?.case !== "itemCompleted") return init;
  const content = body.value?.item?.content;

  if (content?.case !== "userMessage" || !content.value?.clientId) return init;
  const found = mentions.get(content.value.clientId);

  if (!found) return init;

  const enriched = structuredClone(init);
  const updated = enriched.body;

  if (updated?.case === "itemStarted" || updated?.case === "itemCompleted") {
    const user = updated.value.item?.content;

    if (user?.case === "userMessage") {
      user.value.text = found.text;
      user.value.mentions = [...found.mentions];
    }
  }

  return enriched;
}
