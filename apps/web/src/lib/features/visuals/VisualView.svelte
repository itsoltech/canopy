<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ui, Visual } from "@canopy/contracts";
  import { clampVisualHeight, VISUAL_LIMITS } from "@canopy/domain/visuals";
  import { observeActivity } from "#lib/shared/activity.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import VisualFrame from "./VisualFrame.svelte";
  import VisualMenu from "./VisualMenu.svelte";
  import { loadVisual } from "./visual-source.ts";
  import { claimVisualSlot, releaseVisualSlot, waitForVisualSlot, type VisualSlot } from "./visual-slots.ts";

  /**
   * An interactive visual in the reply (docs/agent-visuals.md). The timeline holds only its manifest: the spec is
   * read when the visual comes into view and a frame slot is free. Leaving the view pauses it at once and removes
   * the frame after 5 s; a hidden window removes it at once. Its last height stays reserved, so nothing jumps.
   */
  let {
    visual,
    threadId,
    itemId,
    previewHeader,
    onescape,
  }: {
    visual: Visual;
    threadId: string;
    itemId: string;
    previewHeader?: Snippet<[Visual, Snippet]>;
    onescape?: () => void;
  } = $props();

  const LINGER_MS = 5000;
  let element = $state<HTMLElement>();
  let visible = $state(false);
  let live = $state(false);
  let selected = $state(0);
  let shownVersion = $state(0);
  let response = $state<ui.GetVisualResponse>();
  let history = $state.raw<{ id: string; versions: number[] }>();
  let failure = $state("");
  let attempt = $state(0);
  let height = $state(0);
  let frame = $state<HTMLElement>();
  let fullscreen = $state(false);
  let linger: ReturnType<typeof setTimeout> | undefined;

  const visualId = $derived(visual.visualId);
  const reserved = $derived(height || clampVisualHeight(visual.height || VISUAL_LIMITS.defaultHeight));
  const version = $derived(selected || shownVersion || visual.version);
  const knownVersions = $derived(history?.id === visualId ? history.versions : []);

  const availableVersions = $derived(
    knownVersions.includes(visual.version) ? knownVersions : [...knownVersions, visual.version],
  );

  // Title and description of the version on screen (an older pick may have other ones than the latest).
  const shown = $derived(response?.visual?.version === version ? response.visual : visual);
  const behind = $derived(!selected && shownVersion !== 0 && shownVersion < visual.version);

  const slot: VisualSlot = {
    focused: () => Boolean(frame && frame.contains(document.activeElement)),
    evict: () => (live = false),
  };

  // Follow new versions, except while the frame holds focus: then offer a reload instead.
  $effect(() => {
    const latest = visual.version;

    if (!shownVersion || !slot.focused()) shownVersion = latest;
  });

  $effect(() => {
    if (!element) return;

    return observeActivity(element, (active) => {
      visible = active;
      clearTimeout(linger);

      if (active) live ||= claimVisualSlot(slot, Boolean(previewHeader));
      else if (document.hidden) stop();
      else linger = setTimeout(stop, LINGER_MS);
    });
  });

  $effect(() => {
    if (live || !visible) return;

    return waitForVisualSlot(() => (live ||= visible && claimVisualSlot(slot, false)));
  });

  $effect(() => {
    if (!live) return;
    const wanted = version;
    void attempt;
    let cancelled = false;
    failure = "";

    loadVisual(threadId, visualId, wanted).then(
      (loaded) => {
        if (cancelled) return;
        response = loaded;

        // A cached older version can carry the shorter list known at its publication.
        if (loaded.versions.length >= knownVersions.length) history = { id: visualId, versions: loaded.versions };
      },
      () => {
        if (!cancelled) failure = "Couldn't open this visual.";
      },
    );

    return () => {
      cancelled = true;
    };
  });

  $effect(() => () => {
    clearTimeout(linger);
    releaseVisualSlot(slot);
  });

  function stop() {
    live = false;
    response = undefined;
    releaseVisualSlot(slot);
  }

  function open() {
    if (failure) attempt++;
    live = claimVisualSlot(slot, true);

    if (!live) failure = "Close another visual to open this one.";
  }
</script>

{#snippet actions()}
  <VisualMenu {threadId} {itemId} {visual} {version} versions={availableVersions} bind:selected />
{/snippet}

<figure
  bind:this={element}
  aria-label="Visual: {shown.title}"
  class={previewHeader
    ? "flex min-w-0 flex-1 flex-col bg-surface"
    : "max-w-3xl min-w-0 overflow-hidden rounded-xl border border-zinc-950/10 bg-white dark:border-white/10 dark:bg-zinc-900"}
  data-quote-skip
>
  {#if previewHeader}
    {@render previewHeader(shown, actions)}
  {:else}
    <header class="flex min-w-0 items-center gap-2 border-b border-zinc-950/5 py-1 pr-1 pl-3 dark:border-white/5">
      <div class="min-w-0 flex-1">
        <h3 class="truncate text-base/7 font-medium text-zinc-950 sm:text-sm/6 dark:text-white" title={shown.title}>
          {shown.title}
        </h3>
      </div>
      <span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400"
        >Version {version}</span
      >
      <IconButton
        icon="arrows-pointing-out"
        label="Open full screen"
        size="sm"
        onclick={() => {
          open();
          fullscreen = live;
        }}
      />
      {@render actions()}
    </header>
  {/if}
  {#if behind}
    <div
      role="status"
      class="flex items-center justify-between gap-3 border-b border-zinc-950/5 bg-zinc-50 py-1 pr-1 pl-3 text-sm/6 text-zinc-700 dark:border-white/5 dark:bg-white/5 dark:text-zinc-300"
    >
      <span>A new version is available.</span>
      <Button variant="ghost" size="sm" onclick={() => (shownVersion = visual.version)}>Reload</Button>
    </div>
  {/if}
  <div class={["relative", previewHeader && "my-auto"]} style:min-height="{reserved}px">
    {#if live && response && response.visual?.version === version && !fullscreen}
      {#key response.visual.version}
        <VisualFrame
          {response}
          maxHeight={VISUAL_LIMITS.maxHeight}
          active={visible}
          onescape={() => {
            if (slot.focused()) onescape?.();
          }}
          onheight={(next) => (height = next)}
          onframe={(next) => (frame = next)}
        />
      {/key}
    {:else}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
        <p class="line-clamp-4 max-w-prose text-base/7 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
          {failure || shown.description}
        </p>
        {#if fullscreen}
          <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Shown in full screen.</p>
        {:else if failure}
          <Button variant="secondary" size="sm" onclick={open}>Retry</Button>
        {:else if !live}
          <Button variant="secondary" size="sm" onclick={open}>Open visual</Button>
        {:else}
          <p role="status" class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Loading visual…</p>
        {/if}
      </div>
    {/if}
  </div>
  <figcaption class="sr-only">{shown.description}</figcaption>
</figure>

{#if fullscreen}
  <Dialog bind:open={fullscreen} title={shown.title} description="Version {version}" size="output" fullscreen>
    {#await loadVisual(threadId, visual.visualId, version)}
      <p role="status" class="p-4 text-sm/6 text-zinc-500">Loading visual…</p>
    {:then loaded}
      <VisualFrame
        response={loaded}
        maxHeight={Math.max(VISUAL_LIMITS.minHeight, innerHeight - 160)}
        active
        onescape={() => (fullscreen = false)}
      />
    {:catch}
      <p role="alert" class="p-4 text-sm/6 text-zinc-700 dark:text-zinc-300">Couldn't open this visual.</p>
    {/await}
  </Dialog>
{/if}
