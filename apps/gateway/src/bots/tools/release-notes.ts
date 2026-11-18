import { fetchReleaseNotes, RELEASE_NOTES_URL, releaseVersionsForPullRequests } from "@canopy/domain/release/notes";
import { Schema } from "effect";
import { Invalid } from "../../store/errors.ts";
import { decoded, define, object } from "./shared.ts";

const Request = Schema.Struct({ pull_requests: Schema.NonEmptyArray(Schema.Int) });

export const canopyReleaseVersions = define(
  "get_canopy_release_versions",
  "For PR numbers in itsoltech/canopy, read the earliest indexed published Nightly, Beta and Stable release whose public changelog explicitly references each PR. Missing matches do not prove that a PR has not shipped. This index may lag publication or omit older history. Call with 1 to 50 PR numbers.",
  object({ pull_requests: { type: "array", items: { type: "integer", minimum: 1 }, minItems: 1, maxItems: 50 } }, [
    "pull_requests",
  ]),
  "Checking Canopy release notes",
  async ({ args }) => {
    const request = decoded(Request, args);

    const index = await fetchReleaseNotes().catch(() => {
      throw new Invalid("Canopy release notes are unavailable. Try again later.");
    });

    return {
      source: RELEASE_NOTES_URL,
      truncated_channels: index.truncated,
      matches: releaseVersionsForPullRequests(index, request.pull_requests),
    };
  },
  "read",
);
