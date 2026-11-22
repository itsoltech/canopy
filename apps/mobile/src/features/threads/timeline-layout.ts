import { Platform } from "react-native";
import { useAppearance } from "../../state/appearance";
import { useContentInsets } from "../../ui/ScreenFrame";
import { ui } from "@canopy/contracts";

/** Inverted lists put the oldest edge at the top. A new first turn keeps its prompt there as work arrives. */
export function useThreadTimelineStyle(initial: boolean, composerHeight: number) {
  const { appearance } = useAppearance();
  const { bottom } = useContentInsets();

  const maxWidth =
    appearance.chatWidth === ui.ChatWidth.FULL ? undefined : appearance.chatWidth === ui.ChatWidth.WIDE ? 1024 : 768;

  return {
    maxWidth,
    paddingTop: 24,
    flexGrow: 1,
    gap: 0,
    justifyContent: initial ? ("flex-end" as const) : undefined,
    // UIKit's inset is outside the Yoga content. Let it take its own space when filling the viewport.
    marginBottom: initial && Platform.OS === "ios" ? bottom + composerHeight : undefined,
  };
}
