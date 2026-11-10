<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import type { Tone } from "#lib/shared/ui/tone.ts";
  import UpdateProgress from "./UpdateProgress.svelte";

  let {
    name,
    icon,
    current,
    target = "",
    metadata = "",
    status,
    tone = "neutral",
    detail = "",
    notice = "",
    error = "",
    busy = false,
    progress,
    action,
    children,
    class: className,
  }: {
    name: string;
    icon: IconName;
    current: string;
    target?: string;
    metadata?: string;
    status: string;
    tone?: Tone;
    detail?: string;
    notice?: string;
    error?: string;
    busy?: boolean;
    progress?: number;
    action?: Snippet;
    children?: Snippet;
    class?: ClassValue;
  } = $props();
</script>

<div class={["min-w-0 py-2", className]}>
  <!-- Icon, badge and action sit on the name line; the action column keeps its width, so badges line up. -->
  <div class="flex min-w-0 items-start gap-2">
    <span class="flex h-5 shrink-0 items-center"><Icon name={icon} /></span>
    <div class="min-w-0 flex-1">
      <div class="flex h-5 min-w-0 items-center gap-2">
        <p class="min-w-0 flex-1 truncate text-sm/5 font-medium" title={name}>{name}</p>
        <Badge compact {tone}>{status}</Badge>
      </div>
      <p
        class="flex min-w-0 gap-1 font-mono text-xs/4 text-muted select-text"
        title={`${current || "Version unknown"}${target && target !== current ? ` → ${target}` : ""}`}
      >
        <span class="min-w-0 truncate">{current || "Version unknown"}</span>
        {#if target && target !== current}<span aria-hidden="true">→</span><span class="min-w-0 truncate">{target}</span
          >{/if}
      </p>
      {#if metadata}<p class="truncate text-xs/4 text-muted" title={metadata}>{metadata}</p>{/if}
    </div>
    <div class="flex h-5 w-8 shrink-0 items-center justify-center sm:w-7">
      {#if action}{@render action()}
      {:else if detail}<IconButton icon="information-circle" size="sm" label={detail} />{/if}
    </div>
  </div>
  {#if busy}<UpdateProgress label={`${name}: ${status}`} value={progress} class="mt-1.5 ml-6" />{/if}
  {#if notice}<p class="mt-1 ml-6 text-xs/5 wrap-anywhere text-muted" role="status">{notice}</p>{/if}
  {#if error}
    <Disclosure class="mt-1 ml-6" summaryClass="text-xs/5 text-rose-600 dark:text-rose-400">
      {#snippet summary()}<span class="break-anywhere line-clamp-2">{error}</span>{/snippet}
      <p class="break-anywhere max-h-40 overflow-y-auto py-2 text-xs/5 text-rose-600 select-text dark:text-rose-400">
        {error}
      </p>
    </Disclosure>
  {/if}
  {#if children}<div class="ml-6 min-w-0">{@render children()}</div>{/if}
</div>
