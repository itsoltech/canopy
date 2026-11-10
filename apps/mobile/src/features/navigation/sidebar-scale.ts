import { contextType, typography } from "@canopy/ui";
import { useTypography } from "../../ui/theme";

/** Sidebar rows use the next type step while retaining the device's font and Interface size. */
export function useSidebarTypography() {
  const type = useTypography();
  const scale = type.body.fontSize / typography.body.fontSize;

  return {
    title: type.body,
    meta: type.small,
    caption: {
      ...type.small,
      fontSize: contextType.chromeSmall.fontSize * scale,
      lineHeight: contextType.chromeSmall.lineHeight * scale,
    },
  };
}
