<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { Snippet } from "svelte";
  import { timestampFromMs } from "@bufbuild/protobuf/wkt";
  import type { ui } from "@canopy/contracts";
  import { hasComposerContent, matchesComposerTarget } from "@canopy/domain/composer-drafts";
  import Button from "#lib/shared/ui/Button.svelte";
  import PendingDraft from "./PendingDraft.svelte";
  import { formatRelative } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { remoteDrafts } from "./remote.svelte.ts";
  import { webDrafts } from "./local.svelte.ts";
  import type { WebComposerDraft } from "./state.svelte.ts";
  import DraftsDialog from "./DraftsDialog.svelte";
  import { listDrafts } from "./api.ts";

  let {
    draft,
    threadId = "",
    disabled = false,
    children,
    indicatorOnly = false,
  }: {
    draft: WebComposerDraft;
    threadId?: string;
    disabled?: boolean;
    children?: Snippet;
    indicatorOnly?: boolean;
  } = $props();

  let open = $state(false);
  let fallback = $state<ui.ComposerDraft>();

  let newer = $derived(
    [...remoteDrafts.rows, ...(fallback ? [fallback] : [])].find(
      (row) =>
        matchesComposerTarget(row.target, draft.targetKey) &&
        row.id !== draft.id &&
        row.updatedAtMs > draft.publishedAtMs,
    ),
  );

  let busy = $state(false);

  $effect(() => {
    const incoming = newer;

    if (incoming) untrack(() => (draft.moved = ""));
  });

  async function refresh() {
    if (!draft.targetKey || !webDrafts.ready) return;

    try {
      await remoteDrafts.load();
    } catch {
      /* The local draft stays usable while disconnected. */
    }
  }

  async function take(incoming: ui.ComposerDraft, replace = false) {
    if (disabled || draft.locked) throw new Error("Finish the current composer action, then retry.");

    if (!matchesComposerTarget(incoming.target, draft.targetKey))
      throw new Error("Open this draft in its own composer.");
    const composer = draft;
    busy = true;

    try {
      await composer.take(incoming, replace);
      remoteDrafts.invalidate();
      await remoteDrafts.load();
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    void threadId;
    void webDrafts.ready;
    void refresh();
  });

  onMount(() => remoteDrafts.subscribe());

  $effect(() => {
    const missing = !remoteDrafts.rows.some((row) => row.target?.threadId === threadId);
    const needed = threadId && missing && remoteDrafts.next && remoteDrafts.threadIds.includes(threadId);
    fallback = undefined;

    if (!needed) return;
    let cancelled = false;
    void listDrafts(webDrafts.deviceId, threadId)
      .then((page) => {
        if (!cancelled) fallback = page.drafts[0];
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  });
</script>

{#if !indicatorOnly}<PendingDraft {draft} />{/if}
{#if newer || draft.moved}
  <div class="flex h-8 w-full min-w-0 items-center gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
    <p class="min-w-0 flex-1 truncate" role="status" title={draft.moved || undefined}>
      {#if draft.moved}{draft.moved}{:else if newer}Draft from {newer.deviceName} · {formatRelative(
          timestampFromMs(Number(newer.updatedAtMs)),
          clock.now,
        )}{/if}
    </p>
    {#if newer && !draft.moved}
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled || busy}
        onclick={() => {
          const incoming = newer;
          if (incoming) {
            if (hasComposerContent(draft.content())) {
              open = true;
              return;
            }
            void take(incoming).catch(() => {
              draft.error = "Could not continue this draft. Open Drafts and retry.";
            });
          }
        }}>Take over</Button
      >
    {:else}<Button size="sm" variant="ghost" onclick={() => (draft.moved = "")}>Dismiss</Button>{/if}
  </div>
{:else}{@render children?.()}{/if}
<DraftsDialog bind:open {draft} ontake={take} />
