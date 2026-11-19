<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import ContinueWorktreeDialog from "#lib/features/worktrees/ContinueWorktreeDialog.svelte";

  let {
    thread,
    worker,
    away = false,
    class: className,
  }: { thread: ui.Thread; worker?: ui.Worker; away?: boolean; class?: ClassValue } = $props();

  const capabilities = useGatewayCapabilities();

  const reason = $derived(
    away
      ? "Reconnect the home computer to continue."
      : !thread.workspaceId
        ? "This workspace is unavailable. Check project settings to continue."
        : !worker?.online
          ? "Reconnect this computer to continue."
          : !worker.worktrees
            ? "Update Canopy on this computer to create a worktree."
            : capabilities?.methods && !capabilities.methods.includes("ContinueThreadInWorktree")
              ? "Update Canopy on your gateway to continue in a new worktree."
              : "",
  );

  let open = $state(false);
</script>

<section
  aria-label="Read-only thread"
  class={[
    "flex min-h-36 min-w-0 flex-col justify-center gap-4 rounded-2xl bg-zinc-950/3 p-4 ring-1 ring-zinc-950/8 sm:p-5 dark:bg-white/3 dark:ring-white/8",
    className,
  ]}
>
  <div class="min-w-0">
    <h2 class="font-medium text-balance text-zinc-800 dark:text-zinc-200">This thread is read-only</h2>
    <p class="pt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      Its worktree was removed. Continue in a new worktree with an excerpt of its history.
    </p>
  </div>
  <div class="flex min-w-0 flex-wrap items-center gap-3">
    <Button size="sm" variant="primary" icon="git-fork" disabled={Boolean(reason)} onclick={() => (open = true)}>
      Continue work
    </Button>
    {#if reason}<p class="min-w-0 flex-1 basis-48 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {reason}
      </p>{/if}
  </div>
</section>

<ContinueWorktreeDialog bind:open {thread} disabled={Boolean(reason)} />
