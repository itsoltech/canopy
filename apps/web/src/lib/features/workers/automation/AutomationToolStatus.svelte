<script lang="ts">
  import { AgentTool, type ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  let {
    item,
    disabled,
    installing,
    saving,
    oninstall,
    onenable,
  }: {
    item: ui.WorkerAgentTool;
    disabled: boolean;
    installing: boolean;
    saving: boolean;
    oninstall: () => void;
    onenable: (enabled: boolean) => void;
  } = $props();

  const tool = $derived(item.tool!);
  let access = $state(false);

  $effect(() => {
    if (!saving) access = item.enabled;
  });

  const running = $derived(tool.install?.state === "running");
  const failed = $derived(!tool.ready && tool.install?.state === "failed");

  const status = $derived(
    running
      ? "Installing…"
      : failed
        ? "Install failed"
        : tool.ready
          ? "Ready"
          : tool.installed
            ? "Needs setup"
            : "Not installed",
  );
</script>

<div class="grid min-w-0 gap-3">
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex min-w-0 flex-wrap items-center gap-2">
      <Badge tone={running ? "sky" : failed ? "rose" : tool.ready ? "emerald" : "neutral"}>{status}</Badge>
      {#if tool.version}<span class="font-mono text-sm/5 text-zinc-500 select-text dark:text-zinc-400"
          >{tool.version}</span
        >{/if}
    </div>
    {#if item.action || running}
      <Button
        size="sm"
        icon="plus"
        disabled={disabled || Boolean(item.blockedReason) || running}
        loading={running || installing}
        onclick={oninstall}
      >
        {tool.tool === AgentTool.BROWSER ? "Install with browser" : "Install tool"}
      </Button>
    {/if}
  </div>
  {#if tool.detail && tool.detail !== status && !running}<p
      class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400"
    >
      {tool.detail}
    </p>{/if}
  {#if item.blockedReason && !running}<p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">
      {item.blockedReason}
    </p>{/if}
  {#if failed}<p class="text-sm/5 text-rose-700 dark:text-rose-400" role="alert">
      Check the install log, then retry.
    </p>{/if}
  {#if tool.path || item.log.length || tool.install?.error}
    <Disclosure>
      {#snippet summary()}<span class="text-sm/5 text-zinc-500 dark:text-zinc-400"
          >{item.log.length || tool.install?.error ? "Show install log" : "Show tool details"}</span
        >{/snippet}
      <div class="grid min-w-0 gap-2 pt-2">
        {#if tool.path}<p class="font-mono text-sm/5 break-all text-zinc-500 select-text dark:text-zinc-400">
            {tool.path}
          </p>{/if}
        {#if item.log.length || tool.install?.error}<CodeBlock
            text={[...item.log, tool.install?.error].filter(Boolean).join("\n")}
            label="Automation tool install log"
          />{/if}
      </div>
    </Disclosure>
  {/if}
  <div class="flex items-start justify-between gap-4 border-t border-zinc-950/5 pt-3 dark:border-white/10">
    <div class="min-w-0">
      <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">Allow agent access</p>
      <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
        Claude, Codex and Grok can use this tool during turns on this worker.
      </p>
    </div>
    <div class="pt-0.5">
      <Switch
        name="automation-agent-access"
        label="Allow agent access"
        bind:checked={access}
        disabled={disabled || saving}
        onchange={onenable}
      />
    </div>
  </div>
</div>
