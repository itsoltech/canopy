<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { placementPath } from "@canopy/domain/git-heads";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import { copyText } from "#lib/shared/clipboard.ts";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { revealThreadDirectory } from "../api.ts";
  import { onThisComputer } from "../thread-actions.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PanelRow from "./PanelRow.svelte";
  import ThreadBranch from "./ThreadBranch.svelte";

  let {
    thread,
    worker,
    onworktree,
    class: className,
  }: { thread: ui.Thread; worker?: ui.Worker; onworktree: () => void; class?: ClassValue } = $props();

  const path = $derived(placementPath(thread.cwd, worker?.homeDirectory));
  let revealing = $state(false);

  const capabilities = useGatewayCapabilities();

  // Only a folder on this computer opens here; another machine's would open on that machine.
  const local = $derived(onThisComputer(thread, worker, capabilities?.ownGateway ?? false));

  /** This computer's file manager opens the directory. */
  async function reveal() {
    revealing = true;

    try {
      await revealThreadDirectory(thread.id);
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "Could not open the folder", { tone: "error" });
    } finally {
      revealing = false;
    }
  }
</script>

<section aria-label="Placement" class={["grid min-w-0 grid-cols-1 px-1.5 pb-1", className]}>
  <PanelRow icon="computer-desktop">
    <TruncatedText text={worker?.name ?? "Unknown worker"} />
    {#snippet aside()}<div class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
        <StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}
      </div>{/snippet}
  </PanelRow>
  <DropdownMenu label={thread.worktree ? "Worktree actions" : "Directory actions"} placement="bottom-start">
    {#snippet trigger(props)}<button
        type="button"
        {...props}
        aria-label={`${thread.worktree ? "Worktree" : "Directory"} ${thread.cwd}`}
        class="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-base/5 text-zinc-700 focus-ring hover:bg-zinc-950/4 hover:text-zinc-950 sm:min-h-8 sm:text-sm/5 dark:text-zinc-300 dark:hover:bg-white/5 dark:hover:text-white"
        {@attach tooltip(`${thread.worktree ? "Worktree" : "Directory"}: ${thread.cwd}`)}
      >
        <Icon name="folder" />
        {#if thread.worktree}<MiddleTruncatedText text={path.name} hint={false} class="flex-1 font-mono" />{:else}<span
            class="flex min-w-0 flex-1 font-mono"
            ><span class="min-w-0 truncate text-zinc-500 dark:text-zinc-400" dir="rtl"
              ><bdi dir="ltr">{path.parent}</bdi></span
            ><span class="flex max-w-[75%] min-w-0 shrink-0 font-semibold text-zinc-800 dark:text-zinc-200"
              ><MiddleTruncatedText text={path.name} hint={false} /></span
            ></span
          >{/if}
        <Icon name="ellipsis-horizontal" class="shrink-0" />
      </button>{/snippet}
    <MenuItem icon="copy" onselect={() => void copyText(thread.cwd)}>Copy path</MenuItem>
    {#if local}<MenuItem icon="folder-open" disabled={revealing} onselect={() => void reveal()}>Open folder</MenuItem
      >{/if}
    {#if thread.worktree}<MenuItem icon="cog-6-tooth" onselect={onworktree}>Manage worktree</MenuItem>{/if}
  </DropdownMenu>
  {#if thread.worktree || thread.checkoutHead}<ThreadBranch {thread} {worker} />{/if}
</section>
