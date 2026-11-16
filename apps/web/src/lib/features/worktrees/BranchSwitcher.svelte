<script lang="ts">
  import { untrack } from "svelte";
  import type { GitRef, ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import SearchPicker from "#lib/shared/ui/SearchPicker.svelte";
  import PickerRow from "#lib/shared/ui/PickerRow.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import RefLabel from "#lib/shared/ui/RefLabel.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  /** Shared branch selection and explicit consent to move local changes to another branch. */
  let {
    label,
    currentBranch,
    detached = false,
    reason = "",
    hint,
    pill = false,
    load,
    onswitch,
    onbusy,
    class: className,
  }: {
    label: string;
    currentBranch: string;
    detached?: boolean;
    reason?: string;
    hint?: string;
    pill?: boolean;
    load: () => Promise<ui.ListGitRefsResponse>;
    onswitch: (ref: GitRef, stashChanges: boolean) => Promise<string>;
    onbusy?: (busy: boolean) => void;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let loading = $state(false);
  let busy = $state(false);
  let error = $state("");
  let warning = $state("");
  let unavailable = $state("");
  let refs = $state<GitRef[]>([]);
  let pending = $state<GitRef>();
  let confirm = $state(false);
  let feedbackOpen = $state(false);
  const blocked = $derived(reason || unavailable);
  const title = $derived([hint || label, blocked].filter(Boolean).join(" · "));

  $effect(() => {
    if (!open || reason) return;
    let cancelled = false;
    loading = true;
    error = "";
    unavailable = "";
    refs = [];
    void untrack(load)
      .then((result) => {
        if (cancelled) return;

        if (!result.supported) unavailable = result.detail || "This directory is not a git checkout.";
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

  function setBusy(value: boolean) {
    busy = value;
    onbusy?.(value);
  }

  async function select(ref: GitRef) {
    if (blocked || busy) return;
    setBusy(true);
    error = "";
    warning = "";

    try {
      // Re-read the selected checkout, including worktrees, immediately before deciding on consent.
      const result = await load();

      if (!result.supported) {
        error = result.detail || "This directory is not a git checkout.";

        return;
      }

      if (result.refs?.dirty) {
        pending = ref;
        confirm = true;

        return;
      }

      await change(ref, false);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not read branches. Reopen the picker to retry.";
    } finally {
      setBusy(false);
    }
  }

  async function change(ref: GitRef, stashChanges: boolean) {
    try {
      warning = await onswitch(ref, stashChanges);
      confirm = false;
      pending = undefined;

      if (warning && pill) feedbackOpen = true;
    } catch (cause) {
      // A file may change after the read. Ask for consent; never silently retry with stash enabled.
      if (!stashChanges) {
        const fresh = await load().catch(() => undefined);

        if (fresh?.refs?.dirty) {
          pending = ref;
          confirm = true;

          return;
        }
      }

      error = cause instanceof Error ? cause.message : "Could not switch branches. Reopen the picker to retry.";
    }
  }

  async function confirmSwitch() {
    if (!pending || busy || reason) return;
    setBusy(true);
    error = "";

    try {
      await change(pending, true);
    } finally {
      setBusy(false);
    }
  }
</script>

<div class={["min-w-0", className]}>
  <SearchPicker
    bind:open
    label="Switch branch"
    searchLabel="Search branches"
    placeholder="Search branches…"
    items={refs}
    key={(ref) => `${ref.remote ? "remote" : "local"}:${ref.name}`}
    text={(ref) => ref.name}
    value={!detached ? `local:${currentBranch}` : undefined}
    groupOf={(ref) => (ref.remote ? "Remote branches" : "Local branches")}
    disabled={(ref) => busy || Boolean(blocked) || (!ref.remote && ref.name === currentBranch && !detached)}
    onselect={(ref) => void select(ref)}
  >
    {#snippet trigger(props)}
      {#if pill}
        <PillButton
          {...props}
          aria-label="Switch branch: {label}"
          aria-disabled={Boolean(reason) || busy}
          aria-busy={busy}
          {title}
          onclick={(event) => {
            if (!reason && !busy) props.onclick(event);
          }}
          class="w-full max-w-full"
        >
          <Icon name={busy ? "arrow-path" : "git-fork"} class={["shrink-0", busy && "motion-safe:animate-spin"]} />
          <RefLabel value={label} />
        </PillButton>
      {:else}
        <button
          type="button"
          {...props}
          aria-label="Switch branch"
          aria-disabled={Boolean(reason) || busy}
          aria-busy={busy}
          onclick={(event) => {
            if (!reason && !busy) props.onclick(event);
          }}
          class={[
            "block w-full min-w-0 rounded-lg text-left focus-ring not-aria-disabled:hover:bg-zinc-950/4 not-aria-disabled:focus-visible:bg-zinc-950/4 dark:not-aria-disabled:hover:bg-white/5 dark:not-aria-disabled:focus-visible:bg-white/5",
            reason || busy ? "text-zinc-500 dark:text-zinc-400" : "text-zinc-700 dark:text-zinc-300",
          ]}
          {@attach tooltip(title)}
        >
          <span class="flex min-h-9 w-full min-w-0 items-center gap-2 px-2 text-base/5 sm:min-h-8 sm:text-sm/5">
            <Icon name="git-fork" class="shrink-0" />
            <MiddleTruncatedText text={label} hint={false} class="flex-1 font-mono" />
            <Icon
              name={busy ? "arrow-path" : "chevron-down"}
              class={["shrink-0", busy && "motion-safe:animate-spin"]}
            />
          </span>
        </button>
      {/if}
    {/snippet}
    {#snippet option(ref, state)}<PickerRow title={ref.name} selected={state.selected} class="font-mono" />{/snippet}
    {#snippet empty(query)}{loading
        ? "Loading branches…"
        : error ||
          unavailable ||
          (query ? `No branches match “${query}”.` : "No branches found. Reopen the picker to retry.")}{/snippet}
  </SearchPicker>
  {#if error && !open && !confirm}<Alert tone="error" class="mt-2">{error}</Alert>{/if}
  {#if warning && !pill}<div class="mt-2">{@render feedback()}</div>{/if}
</div>

{#snippet feedback()}
  <Alert tone="warning">
    <p>Git reported a warning after switching branches. Review the details before continuing.</p>
    <details class="mt-2">
      <summary class="cursor-pointer focus-ring">Show details</summary>
      <p class="mt-2 font-mono break-all">{warning}</p>
      <div class="mt-2"><CopyButton text={warning} label="Copy branch switch details" /></div>
    </details>
  </Alert>
{/snippet}

<Dialog bind:open={feedbackOpen} title="Review branch switch">
  <div class="grid gap-4">
    {@render feedback()}
    <DialogActions><Button data-autofocus onclick={() => (feedbackOpen = false)}>Close</Button></DialogActions>
  </div>
</Dialog>

<Dialog bind:open={confirm} title="Switch branch?" dismissible={!busy}>
  <div class="grid gap-4">
    <p class="text-base/6 text-zinc-600 sm:text-sm/6 dark:text-zinc-300">
      This directory has uncommitted changes. Canopy stashes them, including new files, before switching to
      <strong class="font-mono break-all">{pending?.name}</strong>. It then restores your changes on that branch.
    </p>
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      If restoring changes causes conflicts, Canopy keeps the stash. Resolve the conflicts in your terminal.
    </p>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if reason}<Alert tone="warning">{reason}</Alert>{/if}
    <DialogActions>
      <Button data-autofocus disabled={busy} onclick={() => (confirm = false)}>Cancel</Button>
      <Button variant="danger" loading={busy} disabled={Boolean(reason)} onclick={confirmSwitch}>Switch branch</Button>
    </DialogActions>
  </div>
</Dialog>
