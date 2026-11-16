import { font, useTypography } from "../../ui/theme";

/** Usage overlays keep the compact chrome scale and the device's font preferences. */
export function useUsageTypography() {
  const type = useTypography();

  const heading = {
    fontFamily: type.chrome.fontFamily === font.regular ? font.medium : type.chrome.fontFamily,
    fontWeight: "500" as const,
  };

  return {
    heading: { ...type.chrome, ...heading },
    meta: type.meta,
    section: { ...type.meta, ...heading },
  };
}
