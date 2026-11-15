import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { PrChecksNote } from "@canopy/domain";

/** A CI check note from a turn's or steer's input, for the timeline (docs/agent-bus.md, "Checki CI"). */
export function toUiChecksNote(note: PrChecksNote): ui.PullRequestChecksNote {
  return create(ui.PullRequestChecksNoteSchema, {
    watchId: note.watch_id,
    pullRequestId: note.pull_request_id,
    repository: note.repository,
    number: note.number,
    url: note.url,
    headSha: note.head_sha,
    headChanged: note.head_changed,
    event: note.event,
    reason: note.reason,
    watching: note.watching,
    ...note.counts,
    checks: note.checks.map((check) => ({
      name: check.name,
      state: check.state,
      provider: check.provider,
      url: check.url,
      runId: check.run_id,
    })),
    omitted: note.omitted,
  });
}
