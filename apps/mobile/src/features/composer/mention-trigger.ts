import type { ComposerMentionTrigger } from "@canopy/domain/mentions";

export { composerMentionTrigger as activeTrigger } from "@canopy/domain/mentions";

export interface ActiveTrigger extends ComposerMentionTrigger {
  /** Reopen a dismissed # query from the Attach menu. */
  readonly invocation?: number;
}
