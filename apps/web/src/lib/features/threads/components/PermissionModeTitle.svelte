<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import { isFullAuto, permissionLabel, type PermissionModeKey } from "../labels.ts";

  /** Name of a permission mode in a list of choices: full auto says it never asks; `note` follows (e.g. "Current"). */
  let { mode, note, class: className }: { mode: PermissionModeKey; note?: string | undefined; class?: ClassValue } = $props();
</script>

<span class={["flex flex-wrap items-center gap-x-1.5 gap-y-1", className]}>
  {permissionLabel(mode)}
  {#if isFullAuto(mode)}<Badge tone="amber" icon="shield-exclamation">No prompts</Badge>{/if}
  {#if note}<span class="font-normal text-zinc-500 dark:text-zinc-400">{note}</span>{/if}
</span>
