import { useAppearance } from "../../state/appearance";
import { ui } from "@canopy/contracts";

/** Inverted lists put the oldest edge at the top. A new first turn keeps its prompt there as work arrives. */
export function useThreadTimelineStyle(initial = false) {
  const { appearance } = useAppearance();

  const maxWidth =
    appearance?.chatWidth === ui.ChatWidth.FULL ? undefined : appearance?.chatWidth === ui.ChatWidth.WIDE ? 1024 : 768;

  return {
    maxWidth,
    paddingTop: 24,
    flexGrow: 1,
    gap: 0,
    justifyContent: initial ? ("flex-end" as const) : undefined,
  };
}
