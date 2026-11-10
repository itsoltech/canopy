<script lang="ts">
  import type { GitRef, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { branchSwitchReason, headLabel } from "@canopy/domain/git-heads";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PanelField from "./PanelField.svelte";
  import { threadBranches, switchThreadBranch } from "../branches.ts";

  let { thread, worker, class: className }: { thread: ui.Thread; worker?: ui.Worker; class?: ClassValue } = $props();
  const overview = useOverview();
  const capabilities = useGatewayCapabilities();
  const head = $derived(thread.worktree ?? thread.checkoutHead);

  const reason = $derived(
    branchSwitchReason(thread, worker, overview.computer(thread.nodeId)) ||
      (capabilities?.methods && !capabilities.methods.includes("SwitchThreadBranch")
        ? "Update Canopy to switch branches."
        : ""),
  );

  let open = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state("");
  let checkoutReason = $state("");
  let refs = $state<GitRef[]>([]);

  $effect(() => {
    const id = thread.id;

    if (!open || reason) return;
    let cancelled = false;
    loading = true;
    error = "";
    checkoutReason = "";
    refs = [];
    void threadBranches(id)
      .then((result) => {
        if (cancelled) return;

        if (!result.supported) error = result.detail || "This directory is not a git checkout.";

        if (result.refs?.dirty) checkoutReason = "Commit or stash changes before switching branches.";
        refs = result.refs?.refs ?? [];
      })
      .catch((cause: Error) => {
        if (!cancelled) error = cause.message;
      })
      .finally(() => {
        if (!cancelled) loading = false;
      });

    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (reason || busy) open = false;
  });

  async function select(ref: GitRef) {
    if (reason || checkoutReason || busy) return;
    busy = true;
    error = "";

    try {
      await switchThreadBranch(thread.id, ref);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not switch branches. Reopen the picker to retry.";
    } finally {
      busy = false;
    }
  }
</script>

{#snippet value()}
  <PanelField icon="git-fork" label="Branch">
    <p class="font-mono text-sm/5 wrap-anywhere select-text sm:text-xs/5">
      {head ? headLabel(head) : "Unknown branch"}
    </p>
    {#if thread.worktree?.baseRef}<p class="flex min-w-0 gap-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        <span class="shrink-0">from</span><MiddleTruncatedText
          text={thread.worktree.baseRef}
          class="font-mono select-text"
        />
      </p>{/if}
    {#snippet aside()}
      <Icon name={busy ? "arrow-path" : "chevron-down"} class={["shrink-0", busy && "motion-safe:animate-spin"]} />
    {/snippet}
  </PanelField>
{/snippet}

<div class={["min-w-0", className]}>
  <SearchPicker
    bind:open
    label="Switch branch"
    searchLabel="Search branches"
    placeholder="Search branches…"
    items={refs}
    key={(ref) => `${ref.remote ? "remote" : "local"}:${ref.name}`}
    text={(ref) => ref.name}
    value={head && !head.detachedCommit ? `local:${head.branch}` : undefined}
    groupOf={(ref) => (ref.remote ? "Remote branches" : "Local branches")}
    disabled={(ref) =>
      busy || Boolean(reason || checkoutReason) || (!ref.remote && ref.name === head?.branch && !head.detachedCommit)}
    onselect={(ref) => void select(ref)}
  >
    {#snippet trigger(props)}
      <button
        type="button"
        {...props}
        aria-disabled={Boolean(reason) || busy}
        onclick={(event) => {
          if (!reason && !busy) props.onclick(event);
        }}
        aria-label="Switch branch"
        class={[
          "block w-full min-w-0 rounded-lg text-left focus-ring not-aria-disabled:hover:bg-zinc-950/4 not-aria-disabled:focus-visible:bg-zinc-950/4",
          reason || checkoutReason || busy ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-700 dark:text-zinc-300",
          "dark:not-aria-disabled:hover:bg-white/5 dark:not-aria-disabled:focus-visible:bg-white/5",
        ]}
        {@attach tooltip(reason || checkoutReason || undefined)}
      >
        {@render value()}
      </button>
    {/snippet}
    {#snippet option(ref, state)}<PickerRow title={ref.name} selected={state.selected} class="font-mono" />{/snippet}
    {#snippet empty(query)}{loading
        ? "Loading branches…"
        : error || (query ? `No branches match “${query}”.` : "No branches found. Refresh to retry.")}{/snippet}
  </SearchPicker>
  {#if checkoutReason}<p role="status" class="px-8 pb-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      {checkoutReason}
    </p>{/if}
  {#if error && !open}<p role="alert" class="px-8 pb-2 text-sm/5 text-red-600 sm:text-xs/5 dark:text-red-400">
      {error}
    </p>{/if}
</div>
