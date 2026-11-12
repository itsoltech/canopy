<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { fileLook } from "@canopy/domain/github-read";
  import { safeHref } from "@canopy/domain/markdown";
  import ReviewDiff from "./ReviewDiff.svelte";
  import type { ReviewDraft } from "./review-draft.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { toneClasses } from "./presentation.ts";
  import ViewedCheckbox from "./ViewedCheckbox.svelte";
  import ReadSkeleton from "./ReadSkeleton.svelte";

  let {
    file,
    snapshot,
    draft,
    historical,
    stale,
    onstate,
    onsettled,
    active,
    patch,
    busy,
    error,
    depth = 0,
    onopen,
    onexpand,
    onclose,
    class: className,
  }: {
    file: github.PullRequestFile;
    snapshot: github.PullRequestSnapshot;
    draft: ReviewDraft;
    historical: boolean;
    stale: boolean;
    onstate: (path: string, state: string) => void;
    onsettled: () => Promise<void>;
    active: boolean;
    patch?: github.PullRequestDiff | undefined;
    busy: boolean;
    error: string;
    depth?: number;
    onopen: () => void;
    onexpand: () => void;
    onclose: () => void;
    class?: ClassValue;
  } = $props();

  const look = $derived(fileLook(file));
  const path = $derived(file.previousPath ? `${file.previousPath} → ${file.path}` : file.path);
  const href = $derived(safeHref(file.url));
</script>

<li class={["min-w-0", className]}>
  <div
    class={[
      "grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-1 border-b border-zinc-950/5 bg-surface dark:border-white/10",
      active && "sticky top-26 z-20",
    ]}
    style:padding-left={`${Math.min(depth, 6) * 12}px`}
  >
    <button
      type="button"
      aria-expanded={active}
      onclick={active ? onclose : onexpand}
      class="flex min-h-11 min-w-0 flex-1 items-center gap-2 py-2 text-left text-sm/5 focus-ring sm:min-h-10 sm:text-xs/5"
    >
      <Icon name={active ? "chevron-down" : "chevron-right"} size="sm" />
      <span class={toneClasses[look.tone]} {@attach tooltip(look.label)}
        ><Icon name={look.icon} label={look.label} tone="inherit" /></span
      >
      <MiddleTruncatedText text={path} class="min-w-0 flex-1 font-mono" />
      <span class="shrink-0 tabular-nums"
        ><span class="text-emerald-700 dark:text-emerald-400">+{file.additions}</span>
        <span class="text-rose-700 dark:text-rose-400">−{file.deletions}</span></span
      >
    </button>
    <ViewedCheckbox {file} {snapshot} {stale} {onstate} {onsettled} />
    <div class="col-start-3 row-start-1 w-7">
      {#if active && href}<IconButton
          icon="arrow-top-right-on-square"
          label="Open file on GitHub"
          size="sm"
          onclick={() => window.open(href, "_blank", "noopener,noreferrer")}
        />{/if}
    </div>
  </div>
  {#if active}<div class="grid min-w-0 gap-2 pb-2">
      {#if busy && !patch}<ReadSkeleton rows={2} />{/if}
      {#if error}<p role="alert" class="text-sm text-rose-700 sm:text-xs dark:text-rose-400">{error}</p>
        <Button variant="ghost" size="sm" onclick={onopen}>Retry</Button>{/if}
      {#if patch?.patch}<ReviewDiff {patch} {file} {snapshot} {draft} {historical} />{/if}
      {#if !busy && !error && !patch?.patch}<div
          class="flex min-w-0 items-center justify-between gap-2 rounded-md bg-zinc-500/5 px-3 py-2 text-sm text-zinc-500 sm:text-xs dark:text-zinc-400"
        >
          <p>{patch?.page?.detail || (file.patchState === "binary" ? "Binary file" : "Patch loads on demand")}</p>
          {#if file.patchState === "binary" || patch}<Button
              variant="ghost"
              size="sm"
              disabled={!href}
              onclick={() => href && window.open(href, "_blank", "noopener,noreferrer")}>Open on GitHub</Button
            >{:else}<Button variant="ghost" size="sm" onclick={onopen}>Load diff</Button>{/if}
        </div>{/if}
      {#if patch?.patch && patch.page?.detail}<p role="status" class="px-2 text-sm text-zinc-500 sm:text-xs">
          {patch.page.detail}
        </p>{/if}
    </div>{/if}
</li>
