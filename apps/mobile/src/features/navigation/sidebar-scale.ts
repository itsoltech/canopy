import { contextType, typography } from "@canopy/ui";
import { useTypography } from "../../ui/theme";
import { useLayout } from "../../state/layout";

export const sidebarListInset = 4;
export const sidebarRowPadding = 8;

/** Use the web sidebar's phone and docked scales with the device's font and Interface size. */
export function useSidebarTypography() {
  const type = useTypography();
  const scale = type.body.fontSize / typography.body.fontSize;
  const { wide } = useLayout();

  return {
    title: {
      ...type.body,
      fontSize: (wide ? contextType.chromeSmall.fontSize : contextType.chrome.fontSize) * scale,
      lineHeight: (wide ? 20 : 22) * scale,
    },
    meta: {
      ...type.small,
      fontSize: (wide ? 12.5 : contextType.chromeSmall.fontSize) * scale,
      lineHeight: (wide ? 18 : 20) * scale,
    },
    heading: { ...type.small, fontSize: (wide ? contextType.chromeSmall.fontSize : typography.small.fontSize) * scale },
    caption: {
      ...type.small,
      fontSize: contextType.chromeSmall.fontSize * scale,
      lineHeight: contextType.chromeSmall.lineHeight * scale,
    },
  };
}
