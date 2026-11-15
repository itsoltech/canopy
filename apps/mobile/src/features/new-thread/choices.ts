import type { ui } from "@canopy/contracts";
import { effectiveThreadDefaults, latestThreadChoices } from "@canopy/domain/new-thread-choices";
import { findChoice, profileValue, type ModelChoice, type ModelSection } from "../models/catalog";
import { modelFor } from "./placement";

type DraftChoices = Pick<ui.ComposerDraftContent, "provider" | "providerProfileId" | "model" | "effort">;

/** Draft choices win; remembered effort belongs only to the matching provider and profile. */
export function newThreadChoices(
  sections: ModelSection[],
  defaults: ReturnType<typeof effectiveThreadDefaults>,
  threads: Iterable<ui.Thread>,
  draft?: DraftChoices,
) {
  const latest = defaults.useLastAgent ? latestThreadChoices(threads) : undefined;
  const remembered = latest?.lastUserTurnChoices;

  const matching = (provider: ui.Thread["provider"], profileId: string) =>
    sections.find((s) => s.provider === provider && s.profileId === profileValue(profileId));

  const offered = (section: ModelSection | undefined, model: string) =>
    findChoice(section, model) ?? findChoice(section, "");

  const picked =
    draft?.model !== undefined ? offered(matching(draft.provider, draft.providerProfileId), draft.model) : undefined;

  const previous = latest
    ? offered(matching(latest.provider, latest.providerProfileId), remembered?.model ?? "")
    : undefined;

  const ofProvider = sections.filter((s) => s.provider === defaults.provider && s.choices.length);
  const section = ofProvider.find((s) => s.profileId === profileValue(defaults.providerProfileId)) ?? ofProvider[0];
  const fromDefaults = section ? offered(section, modelFor(defaults, section.provider)) : undefined;
  const selected = picked ?? previous ?? fromDefaults ?? sections.map((s) => findChoice(s, "")).find(Boolean);

  const sameAgent = (provider: ui.Thread["provider"], profileId: string) =>
    selected?.provider === provider && selected.profileId === profileValue(profileId);

  const asked =
    draft?.effort !== undefined
      ? !draft.provider || sameAgent(draft.provider, draft.providerProfileId)
        ? draft.effort
        : ""
      : latest && sameAgent(latest.provider, latest.providerProfileId)
        ? remembered?.effort
        : "";

  return {
    selected,
    model: selected && !picked && !previous && selected.isDefault ? "" : (selected?.model ?? ""),
    effort: supportedEffort(selected, asked),
  };
}

function supportedEffort(choice: ModelChoice | undefined, asked: string | undefined) {
  if (asked && choice?.efforts.includes(asked)) return asked;

  return choice?.efforts.includes(choice.defaultEffort) ? choice.defaultEffort : "";
}
