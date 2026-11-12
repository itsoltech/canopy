import { getContext, setContext } from "svelte";
import type { ui } from "@canopy/contracts";

const key = Symbol("pr-citation-target");

export const providePrCitationTarget = (target: (quote: ui.Quote) => void, enabled: () => boolean) =>
  setContext(key, { target, enabled });

export const usePrCitationTarget = () => getContext<ReturnType<typeof providePrCitationTarget> | undefined>(key);
