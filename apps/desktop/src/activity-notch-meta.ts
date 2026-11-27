import type { ActivityNotchItem } from "@canopy/ui/desktop";

/** A thread row's sidebar facts around its title: project above it, worker, directory, branch and provider below. */
export type ActivityNotchMeta = Pick<
  ActivityNotchItem,
  "project" | "worker" | "place" | "branch" | "branchLabel" | "provider"
>;

const metaKeys = ["project", "worker", "place", "branch", "branchLabel", "provider"] as const;

/** Copies only the known facts, so main and the notch preload both drop anything else a row carries. */
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
