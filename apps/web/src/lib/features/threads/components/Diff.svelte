<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";
  import DiffLines from "#lib/shared/ui/code/DiffLines.svelte";
  import type { LanguageId } from "#lib/shared/ui/code/languages.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import { devicePreferences as device } from "#lib/features/settings/device-preferences.svelte.ts";

  /** Unified diff in a scrolling code surface, its code highlighted in `lang` (`DiffLines`). Other attributes go on the surface. */
  let {
    diff,
    label,
    lang,
    class: className,
    ...rest
  }: { diff: string; label: string; lang?: LanguageId | undefined; class?: ClassValue } & Omit<
    HTMLAttributes<HTMLDivElement>,
    "class"
  > = $props();
</script>

<div class="flex items-center justify-end gap-2 py-1" aria-label="Diff toolbar">
  <div class="flex gap-1" role="group" aria-label="Diff layout">
    {#each [{ value: "stacked", label: "Stacked" }, { value: "split", label: "Side by side" }] as option (option.value)}
      <Button
        size="sm"
        variant={device.values.diffLayout === option.value ? "primary" : "secondary"}
        aria-pressed={device.values.diffLayout === option.value}
        onclick={() => device.set("diffLayout", option.value)}>{option.label}</Button
      >
    {/each}
  </div>
</div>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  {...rest}
  class={[
    "diff-surface max-h-[32rem] code-surface rounded-lg bg-zinc-950/2.5 py-2 focus-ring dark:bg-white/5",
    className,
  ]}
  tabindex="0"
  role="region"
  aria-label={label}
>
  <DiffLines {diff} {lang} />
</div>
