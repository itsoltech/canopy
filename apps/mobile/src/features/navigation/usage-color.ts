import type { UsageTone } from "@canopy/domain/sidebar-usage";
import type { Colors } from "../../ui/theme";

export const usageColor = (tone: UsageTone, c: Colors) =>
  tone === "extra" ? c.agent : tone === "danger" ? c.danger : tone === "warning" ? c.warning : c.muted;
