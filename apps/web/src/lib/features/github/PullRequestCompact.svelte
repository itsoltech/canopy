<script lang="ts">
  import type { github } from "@canopy/contracts";
  import { checkLook } from "@canopy/domain/github-pr";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PullRequestState from "./PullRequestState.svelte";
  import PullRequestMenu from "./PullRequestMenu.svelte";
  import { toneClasses } from "./presentation.ts";

  let {
    snapshot,
    title,
    compact,
    busy,
    primary,
    oncopy,
    onrefresh,
    onunlink,
    oncontext,
    onclose,
  }: {
    snapshot: github.PullRequestSnapshot;
    title: string;
    compact: boolean;
    busy: boolean;
    primary: { label: string; disabled: boolean; detail: string; run: () => void } | undefined;
    oncopy: (value: string, message: string) => Promise<void>;
    onrefresh: () => void;
    onunlink?: (() => void) | undefined;
    oncontext?: ((action: string) => void) | undefined;
    onclose?: (() => void) | undefined;
  } = $props();

  const ref = $derived(snapshot.summary?.ref);
  const checks = $derived(checkLook(snapshot.summary?.checksState ?? ""));
</script>

<div
  inert={!compact}
  aria-hidden={!compact}
  data-compact={compact}
  class="pr-compact absolute inset-x-0 bottom-0 flex h-12 min-w-0 items-center gap-2 border-b border-divider bg-surface px-3 text-sm/5 sm:text-xs/5"
>
  <PullRequestState state={snapshot.summary?.state ?? ""} iconOnly />
  <div class="grid min-w-0 flex-1">
    <a
      href={`https://github.com/${ref?.repositoryName}/pull/${ref?.number}`}
      target="_blank"
      rel="noreferrer"
      class="flex min-w-0 gap-1 text-zinc-500 hover:underline dark:text-zinc-400"
      title={`${ref?.repositoryName} #${ref?.number}`}
      ><span class="min-w-0 truncate">{ref?.repositoryName}</span><span class="shrink-0">#{ref?.number}</span></a
    >
    <p class="truncate font-medium" {@attach tooltip(title)}>{title}</p>
  </div>
  <span class="shrink-0" {@attach tooltip(`Checks: ${checks.label}`)}
    ><Icon name={checks.icon} class={toneClasses[checks.tone]} label={`Checks: ${checks.label}`} /></span
  >
  {#if primary}<span
      class="max-w-28 min-w-0 shrink-0"
      {@attach tooltip([primary.label, primary.detail].filter(Boolean).join(" · "))}
      ><Button
        class="max-w-full"
        size="sm"
        variant={primary.disabled ? "secondary" : "primary"}
        disabled={primary.disabled}
        aria-label={primary.label}
        onclick={primary.run}><span class="truncate">{primary.label}</span></Button
      ></span
    >{/if}
  <div class="flex shrink-0 items-center gap-1">
    <PullRequestMenu
      url={`https://github.com/${ref?.repositoryName}/pull/${ref?.number}`}
      number={ref?.number ?? 0}
      {busy}
      {oncopy}
      {onrefresh}
      {onunlink}
      {oncontext}
    />
    {#if onclose}<IconButton icon="x-mark" label="Close pull request" size="sm" onclick={onclose} />{/if}
  </div>
</div>

<style>
  .pr-compact {
    opacity: 0;
    translate: 0 var(--distance-micro);
    pointer-events: none;
    transition:
      opacity var(--duration-quick) var(--ease-in-out),
      translate var(--duration-quick) var(--ease-smooth-out);
  }
  .pr-compact[data-compact="true"] {
    opacity: 1;
    translate: 0 0;
    pointer-events: auto;
  }
  @media (prefers-reduced-motion: reduce) {
    .pr-compact {
      transition: none;
      translate: none;
    }
  }
</style>
