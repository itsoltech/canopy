import type { execFileSync } from "node:child_process";
import type { JsonValue } from "@canopy/domain/json";

export function githubRequest(
  args: readonly string[],
  body?: JsonValue,
  run?: typeof execFileSync,
): JsonValue | undefined;
export function githubDraft(
  body: {
    tag_name: string;
    target_commitish: string;
    name: string;
    body: string;
    draft: boolean;
    prerelease: boolean;
    make_latest: string;
  },
  repo?: string,
): void;
export function findGithubRelease(tag: string):
  | {
      tag_name: string;
      draft: boolean;
      prerelease: boolean;
    }
  | undefined;
