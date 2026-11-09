<script lang="ts">
  import type { GitRef, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { branchSwitchReason, headLabel } from "@canopy/domain/git-heads";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
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
  let refs = $state<GitRef[]>([]);

  $effect(() => {
    const id = thread.id;

    if (!open || reason) return;
    let cancelled = false;
    loading = true;
    error = "";
    refs = [];
    void threadBranches(id)
      .then((result) => {
        if (cancelled) return;

        if (!result.supported) error = result.detail || "This directory is not a git checkout.";
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
    if (reason || busy) return;
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
  <div class="min-w-0 space-y-1">
    <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Branch</p>
    <p class="font-mono text-sm/5 wrap-anywhere sm:text-xs/5">{head ? headLabel(head) : "Unknown branch"}</p>
    {#if thread.worktree?.baseRef}<p class="text-sm/5 wrap-anywhere text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        from <code>{thread.worktree.baseRef}</code>
      </p>{/if}
  </div>
{/snippet}

<div class={["grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2 px-2 py-2", className]}>
  <Icon name="git-fork" class="mt-0.5 shrink-0" />
  <div class="grid min-w-0 gap-1">
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
      disabled={(ref) => busy || Boolean(reason) || (!ref.remote && ref.name === head?.branch && !head.detachedCommit)}
      onselect={(ref) => void select(ref)}
    >
      {#snippet trigger(props)}
        <button
          type="button"
          {...props}
          disabled={Boolean(reason) || busy}
          aria-label="Switch branch"
          class="grid min-h-32 w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 rounded-md text-left text-zinc-700 focus-ring enabled:hover:bg-zinc-950/4 dark:text-zinc-300 dark:enabled:hover:bg-white/5"
        >
          {@render value()}
          <Icon name={busy ? "arrow-path" : "chevron-down"} class={["shrink-0", busy && "motion-safe:animate-spin"]} />
        </button>
      {/snippet}
      {#snippet option(ref, state)}<PickerRow title={ref.name} selected={state.selected} class="font-mono" />{/snippet}
      {#snippet empty(query)}{loading
          ? "Loading branches…"
          : error || (query ? `No branches match “${query}”.` : "No branches found. Refresh to retry.")}{/snippet}
    </SearchPicker>
    {#if reason}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{reason}</p>{/if}
    {#if error && !open}<p role="alert" class="text-sm/5 text-red-600 sm:text-xs/5 dark:text-red-400">{error}</p>{/if}
  </div>
</div>
