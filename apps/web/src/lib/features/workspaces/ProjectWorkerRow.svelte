<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { workerPresence } from "#lib/features/computers/computers.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";

  let {
    worker,
    workspace,
    computer,
    onmove,
    onremove,
    class: className,
  }: {
    worker: ui.Worker;
    workspace: ui.Workspace;
    computer: string;
    onmove: () => void;
    onremove: () => void;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const presence = $derived(workerPresence(worker, overview.computer(worker.nodeId)));

  const os = $derived(
    worker.os === "darwin" ? "macOS" : worker.os === "win32" ? "Windows" : worker.os === "linux" ? "Linux" : worker.os,
  );
</script>

<div class={["@container flex min-w-0 items-center gap-2 px-3 py-2", !presence.online && "opacity-55", className]}>
  <StatusDot tone={presence.online ? "emerald" : "neutral"} />
  <div class="grid min-w-0 flex-1 gap-x-3 gap-y-0.5 @xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] @xl:items-center">
    <div class="min-w-0 text-[0.9375rem]/5 sm:text-[0.8125rem]/5">
      <p class="truncate font-medium text-zinc-950 dark:text-white" title={worker.name}>{worker.name}</p>
      <p class="flex min-w-0 gap-1 text-zinc-500 dark:text-zinc-400" title={presence.reason}>
        <span class="truncate">{computer}{os ? ` · ${os}` : ""}</span>
        {#if !presence.online}
          <span class="max-w-1/2 shrink-0 truncate">· {presence.reason ? presence.status : "Offline"}</span>
        {/if}
      </p>
    </div>
    <p class="min-w-0 font-mono text-[0.8125rem]/5 text-zinc-600 select-text dark:text-zinc-400">
      <MiddleTruncatedText text={workspace.rootPath} />
    </p>
  </div>
  <CopyButton text={workspace.rootPath} label="Copy path" />
  <DropdownMenu label="Workspace actions" placement="bottom-end" sheet>
    {#snippet trigger(props)}<IconButton
        icon="ellipsis-horizontal"
        label="Workspace actions for {worker.name}"
        size="sm"
        {...props}
      />{/snippet}
    <MenuItem icon="pencil-square" disabled={!presence.online} onselect={onmove}>Edit path</MenuItem>
    <MenuItem icon="trash" danger disabled={Boolean(worker.nodeId) && !presence.online} onselect={onremove}
      >Remove workspace</MenuItem
    >
  </DropdownMenu>
</div>
