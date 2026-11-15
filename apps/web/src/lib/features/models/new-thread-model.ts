import { Provider, type ui } from "@canopy/contracts";
import { latestThreadChoices } from "@canopy/domain/new-thread-choices";
import { modelFor } from "#lib/features/settings/thread-defaults.ts";
import { profileIdValue, providerKeyOf } from "#lib/features/threads/providers.ts";
import { findOption, type ModelOption } from "./catalog.ts";

/** Resolve remembered choices against this worker's offered models before applying draft picks. */
export function newThreadModel(
  options: readonly ModelOption[],
  defaults: ui.ThreadDefaults,
  threads: Iterable<ui.Thread>,
) {
  const latest = defaults.useLastAgent ? latestThreadChoices(threads) : undefined;
  const provider = providerKeyOf(latest?.provider ?? defaults.provider);
  const profileId = profileIdValue(latest?.providerProfileId ?? defaults.providerProfileId);
  const rememberedModel = latest?.lastUserTurnChoices?.model;
  const remembered = latest && provider ? findOption(options, provider, profileId, rememberedModel ?? "") : undefined;
  const sameProfile = latest && provider ? findOption(options, provider, profileId, "") : undefined;
  const fixedProvider = providerKeyOf(defaults.provider);
  const fixed = fixedProvider ? options.filter((o) => o.provider === fixedProvider) : [];

  const fixedProfile = defaults.providerProfileId
    ? (fixed.find((o) => o.profileId === profileIdValue(defaults.providerProfileId))?.profileId ?? fixed[0]?.profileId)
    : fixed[0]?.profileId;

  const fromDefaults =
    fixedProvider && fixedProfile !== undefined
      ? (findOption(options, fixedProvider, fixedProfile, modelFor(defaults, Provider[fixedProvider])) ??
        findOption(options, fixedProvider, fixedProfile, ""))
      : undefined;

  const option = remembered ?? sameProfile ?? fromDefaults ?? options[0];
  const asked = latest?.lastUserTurnChoices?.effort;

  const effort =
    (remembered || sameProfile) && asked && option?.efforts.some((e) => e.id === asked) ? asked : undefined;

  return { option, effort, remembered: !!remembered };
}
