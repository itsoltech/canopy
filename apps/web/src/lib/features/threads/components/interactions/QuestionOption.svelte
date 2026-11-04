<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Input from "#lib/shared/ui/Input.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    option,
    index,
    multiple,
    name,
    checked,
    recommended,
    disabled,
    onselect,
    class: className,
  }: {
    option: { label: string; description: string };
    index: number;
    multiple: boolean;
    name: string;
    checked: boolean;
    recommended: boolean;
    disabled: boolean;
    onselect: () => void;
    class?: ClassValue;
  } = $props();
</script>

<label
  class={[
    "relative flex cursor-pointer items-start gap-2 rounded-lg px-2 py-0.5 text-sm/5 text-zinc-950 hover:bg-zinc-950/3 has-checked:bg-brand-600/8 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:text-[0.8125rem]/5 dark:text-white dark:hover:bg-white/5 dark:has-checked:bg-brand-500/10 pointer-coarse:min-h-12",
    className,
  ]}
>
  <div class="flex h-lh shrink-0 items-center">
    <Input
      choice
      type={multiple ? "checkbox" : "radio"}
      {name}
      value={option.label}
      {checked}
      {disabled}
      onchange={onselect}
    />
  </div>
  <div class="shrink-0 text-zinc-400 tabular-nums dark:text-zinc-500" aria-hidden="true">{index + 1}.</div>
  <div class="min-w-0 flex-1 wrap-anywhere">
    <div class="flex flex-wrap items-baseline gap-x-2">
      <span class="font-medium">{option.label}</span>{#if recommended}<span class="text-brand-700 dark:text-brand-400"
          >Recommended</span
        >{/if}
    </div>
    {#if option.description}<p class="text-[0.8125rem]/4 text-pretty text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
        {option.description}
      </p>{/if}
  </div>
  <TouchTarget />
</label>
