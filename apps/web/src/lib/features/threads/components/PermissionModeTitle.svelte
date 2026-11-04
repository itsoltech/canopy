<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { isFullAuto, permissionLabel, type PermissionModeKey } from "../labels.ts";

  /** Name of a permission mode in a list of choices: full auto says it never asks; `note` is a quiet tag on the same line (e.g. "Default", "Current"). */
  let {
    mode,
    note,
    class: className,
  }: { mode: PermissionModeKey; note?: string | undefined; class?: ClassValue } = $props();
</script>

<span class={["flex items-center gap-1.5", className]}>
  {permissionLabel(mode)}
  {#if isFullAuto(mode)}<Badge tone="amber" icon="shield-exclamation">No prompts</Badge>{/if}
  {#if note}<Badge>{note}</Badge>{/if}
</span>
