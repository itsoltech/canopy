import type { JsonValue } from "@canopy/domain/json";

export function publishedReleaseTags(releases: readonly JsonValue[]): string[];
export function latestStableTag(tags: readonly string[]): string | undefined;
export function latestBetaTag(tags: readonly string[]): string | undefined;
export function firstNightlyAfterRelease(tags: readonly string[]): string | undefined;
export function closedBetaCores(
  tags: readonly string[],
  publicTags: readonly string[],
  mainHeadTags: readonly string[],
): Set<string>;
