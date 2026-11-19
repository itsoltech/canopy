<script lang="ts">
  import { type AgentTool } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { toolKey, workerTool, type ToolWorker, type AgentToolActions } from "./agent-tools.svelte.ts";
  import ToolActionNote from "./ToolActionNote.svelte";

  let {
    entry,
    tool,
    name,
    actions,
    busy = false,
  }: { entry: ToolWorker; tool: AgentTool; name: string; actions: AgentToolActions; busy?: boolean } = $props();

  const item = $derived(workerTool(entry.worker, tool));
  const info = $derived(item?.tool);
  const key = $derived(toolKey(entry.worker.id, tool));
  const running = $derived(info?.install?.state === "running");
  const failed = $derived(!info?.ready && info?.install?.state === "failed");

  const disabled = $derived(
    busy ||
      Boolean(actions.pending[key]) ||
      (!entry.worker.online && !item?.enabled) ||
      Boolean(entry.readOnly) ||
      !item,
  );

  const update = $derived(item?.action === "update");

  const status = $derived(
    running
      ? "Installing…"
      : failed
        ? "Install failed"
        : update
          ? "Update available"
          : info?.ready
            ? "Ready"
            : info?.installed
              ? "Needs setup"
              : info
                ? "Not installed"
                : "Not checked",
  );

  let access = $state(false);

  $effect(() => {
    if (!actions.pending[key]) access = item?.enabled ?? false;
  });
</script>

<div class="grid min-w-0 gap-2 px-4 py-3 sm:px-5">
  <div class="flex min-w-0 items-center gap-4">
    <div class="min-w-0 flex-1">
      <p class="font-medium text-zinc-950 dark:text-white"><TruncatedText text={entry.worker.name} /></p>
      <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
        <TruncatedText
          text={`${entry.computer} · ${entry.worker.os || "Unknown OS"}${entry.worker.online ? "" : " · Offline"}`}
        />
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-3 sm:gap-4">
      <div class="hidden sm:block">
        <Badge tone={running ? "sky" : failed ? "rose" : info?.ready ? "emerald" : "neutral"}>{status}</Badge>
      </div>
      <Switch
        name={`agent-tool-${key}`}
        label={`Use ${name} on ${entry.worker.name}`}
        bind:checked={access}
        {disabled}
        onchange={(enabled) => void actions.enable(entry.worker.id, tool, enabled)}
      />
    </div>
  </div>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm/5 text-zinc-500 dark:text-zinc-400" role="status">
    <div class="sm:hidden">
      <Badge tone={running ? "sky" : failed ? "rose" : info?.ready ? "emerald" : "neutral"}>{status}</Badge>
    </div>
    {#if info?.version}<span class="font-mono tabular-nums">{info.version}</span>{/if}
    {#if (item?.action || running) && !entry.readOnly}
      <Button
        size="sm"
        icon={update ? "arrow-up" : "arrow-down-tray"}
        disabled={disabled || Boolean(item?.blockedReason) || running}
        loading={running || actions.pending[key] === "install"}
        onclick={() => void actions.install(entry.worker.id, tool)}
        >{update ? "Update tool" : failed ? "Retry install" : info?.installed ? "Repair tool" : "Install tool"}</Button
      >
    {/if}
  </div>
  {#if entry.readOnly}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{entry.readOnly}</p>
  {:else if !entry.worker.online}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
      Connect this worker to enable access or install tools.
    </p>
  {:else if failed}<p class="text-sm/5 text-rose-700 dark:text-rose-400">Check the install log, then retry.</p>
  {:else if item?.blockedReason}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{item.blockedReason}</p>
  {:else if info && !info.ready && info.installed && !running}<p
      class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400"
    >
      {info.detail || "Check tool details to finish setup."}
    </p>{/if}
  {#if info?.path || item?.log.length || info?.install?.error || info?.detail}
    <Disclosure>
      {#snippet summary()}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400"
          >{item?.log.length || info?.install?.error ? "Show install log" : "Show tool details"}</span
        >{/snippet}
      <div class="grid min-w-0 gap-2 pt-2">
        <CodeBlock
          text={[info?.detail, info?.path, ...(item?.log ?? []), info?.install?.error].filter(Boolean).join("\n")}
          label={`${name} details`}
        />
      </div>
    </Disclosure>
  {/if}
  <ToolActionNote {actions} actionKey={key} />
</div>
