import { Effect, Schema } from "effect";
import type { ActivityNotchItem } from "@canopy/ui/desktop";
import { providerKeys } from "@canopy/ui/providers";

/** A thread row's sidebar facts around its title: project above it, worker, directory, branch and provider below. */
export type ActivityNotchMeta = Pick<
  ActivityNotchItem,
  "project" | "worker" | "place" | "branch" | "branchLabel" | "provider"
>;

// Each fact falls back to nothing when it is too long or malformed; the row keeps its title.
const text = Schema.String.check(Schema.isMaxLength(200)).pipe(Schema.catchDecoding(() => Effect.succeedNone));

export const activityNotchMetaFields = {
  project: Schema.optionalKey(text),
  worker: Schema.optionalKey(text),
  place: Schema.optionalKey(text),
  branch: Schema.optionalKey(text),
  branchLabel: Schema.optionalKey(text),
  provider: Schema.optionalKey(Schema.Literals(providerKeys).pipe(Schema.catchDecoding(() => Effect.succeedNone))),
};

const metaKeys = ["project", "worker", "place", "branch", "branchLabel", "provider"] as const;

export function rowMeta(item: ActivityNotchMeta): ActivityNotchMeta | undefined {
  const meta: ActivityNotchMeta = {};

  for (const key of metaKeys) {
    const value = item[key]?.trim();

    if (value) Object.assign(meta, { [key]: value });
  }

  return Object.keys(meta).length ? meta : undefined;
}

export const sameMeta = (left?: ActivityNotchMeta, right?: ActivityNotchMeta): boolean =>
  metaKeys.every((key) => left?.[key] === right?.[key]);
