<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  let { title, description, icon, selected, onclick, disabled, class: className }: { title: string; description: string; icon: IconName; selected: boolean; onclick: () => void; disabled: boolean; class?: ClassValue } = $props();
</script>

<button type="button" {onclick} {disabled} aria-pressed={selected} class={["flex items-start gap-3 rounded-xl p-4 text-left ring-1 ring-zinc-950/10 hover:bg-zinc-950/3 focus-ring aria-pressed:bg-zinc-950/3 aria-pressed:ring-2 aria-pressed:ring-brand-500 disabled:opacity-60 dark:ring-white/10 dark:hover:bg-white/5 dark:aria-pressed:bg-white/5 dark:aria-pressed:ring-brand-500", className]}>
  <Icon name={icon} class="mt-0.5 fill-zinc-500 dark:fill-zinc-400" />
  <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
    <p class="font-medium text-zinc-950 dark:text-white">{title}</p>
    <p class="text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>
  </div>
</button>
