<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { providerPaths } from "@canopy/ui/provider-icons";
  import type { ProviderKey } from "#lib/features/threads/providers.ts";

  /**
   * Claude/OpenAI marks: Simple Icons (CC0). Grok mark: LobeHub icons (MIT), icons/xai.svg.
   * Decorative unless `label` is given. `size="sm"` is 14px, default 16px.
   */
  let {
    provider,
    label,
    size = "md",
    class: className,
  }: { provider: ProviderKey; label?: string | undefined; size?: "sm" | "md"; class?: ClassValue } = $props();

  // Shared CC0 / MIT provider marks, also rendered by react-native-svg.
  const paths = providerPaths;
</script>

<svg
  viewBox="0 0 24 24"
  class={[
    "shrink-0",
    size === "sm" ? "size-3.5" : "size-4",
    provider === "CLAUDE" ? "fill-[#D97757]" : "fill-zinc-950 dark:fill-white",
    className,
  ]}
  aria-hidden={label ? undefined : "true"}
  role={label ? "img" : undefined}
  aria-label={label}
>
  <path d={paths[provider]} />
</svg>
