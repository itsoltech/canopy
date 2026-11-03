import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { MentionCatalogEntrySchema, MentionKind, MentionSchema, type Mention, type MentionCatalogEntry } from "@canopy/contracts";

/**
 * Mentions on the gateway (docs/ui-api.md, "Wzmianki"): how they are stored with a turn or a steer, where a file
 * mention points on the worker, and the platform's own commands.
 */

/** Stored in turns.input / turn_steers.input: `mentions` in the message (UI chips), `delivered` in the text the model got. */
export interface StoredMentions {
  readonly mentions?: JsonValue[];
  readonly delivered?: JsonValue[];
}

export function mentionsToJson(mentions: readonly Mention[]): JsonValue[] {
  return mentions.map((m) => toJson(MentionSchema, m));
}

export function mentionsFromJson(json: readonly JsonValue[] | undefined): Mention[] {
  return (json ?? []).flatMap((value) => {
    try {
      return [fromJson(MentionSchema, value, { ignoreUnknownFields: true })];
    } catch {
      return [];
    }
  });
}

/** A workspace-relative path ("/" separators) under the thread's folder, with the folder's separators. */
export function workerPath(cwd: string, relative: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(cwd);
  const sep = windows ? "\\" : "/";
  const base = cwd.endsWith(sep) && cwd.length > 1 ? cwd.slice(0, -1) : cwd;
  return [base, ...relative.split("/").filter((part) => part && part !== ".")].join(sep);
}

/** The platform's commands: run by the gateway, the same for every provider. */
export const PLATFORM_COMMANDS: readonly MentionCatalogEntry[] = [
  create(MentionCatalogEntrySchema, {
    kind: MentionKind.COMMAND,
    name: "goal",
    description: "Set a goal: the agent keeps working until it is met (the rest of the message is the objective)",
    argumentHint: "<objective>",
    source: "platform",
  }),
];

export function isPlatformCommand(mention: Mention): boolean {
  return mention.kind === MentionKind.COMMAND && mention.source === "platform";
}
