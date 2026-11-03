<script lang="ts">
  import { CliInstallMethod, type ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import ActionNote from "./ActionNote.svelte";
  import CliStateBadge from "./CliStateBadge.svelte";
  import InlineCommand from "./InlineCommand.svelte";
  import { cliActions, cliLabel, methodLabel, sentence } from "./cli-tools.svelte.ts";

  /** One provider CLI on a worker: version and install method, update state, and the one action allowed. */
  let { workerId, item, class: className }: { workerId: string; item: ui.WorkerCliTool; class?: ClassValue } = $props();
  const actions = cliActions();
  const tool = $derived(item.tool!);
  const key = $derived(`${workerId}/${tool.provider}`);
  const installing = $derived(tool.install?.state === "running");
  const installed = $derived(tool.method !== CliInstallMethod.NOT_INSTALLED && tool.method !== CliInstallMethod.UNSPECIFIED);
  const where = $derived([methodLabel(tool.method), tool.path].filter(Boolean).join(" · "));
  /** A command to run on the machine instead: a package manager's, or an installer this platform has no recipe for. */
  const manual = $derived(!item.action && tool.manualCommand && (item.managedBy || !installed) ? tool.manualCommand : "");
</script>

<div class={["grid grid-cols-1 gap-3", className]}>
  <div class="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">
          {cliLabel(tool.provider)}
          <span class="font-mono font-normal text-zinc-500 tabular-nums dark:text-zinc-400">{installed ? tool.version || "version unknown" : "Not installed"}</span>
        </p>
        <CliStateBadge {item} />
      </div>
      {#if installed}<p class="truncate text-sm/5 text-zinc-500 dark:text-zinc-400" title={tool.resolvedPath || tool.path}>{where}</p>{/if}
      {#if item.latest?.error}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">Couldn't check for updates: {item.latest.error}.</p>{/if}
    </div>
    {#if item.action}
      <div class="flex shrink-0 items-center gap-3">
        {#if item.blockedReason && !installing}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">{item.blockedReason}</p>{/if}
        <Button size="sm" icon={item.action === "install" ? "plus" : "arrow-up"} loading={installing || actions.pending[key]} disabled={Boolean(item.blockedReason) || installing} onclick={() => void actions.install(workerId, tool.provider)}>
          {item.action === "install" ? "Install" : "Update"}
        </Button>
      </div>
    {/if}
  </div>

  {#if item.managedBy && !item.action}
    <p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">
      Managed by {item.managedBy}{manual ? " — update it there:" : "."}{#if !manual && tool.detail} {sentence(tool.detail)}{/if}
    </p>
  {:else if !item.action && tool.detail && !installing}
    <p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">{sentence(tool.detail)}</p>
  {/if}
  {#if manual}<InlineCommand text={manual} />{/if}

  <ActionNote error={actions.errors[key] || (tool.install?.state === "failed" && tool.install.error ? `${tool.install.error}.` : "")} />

  {#if item.log.length > 0}
    <Disclosure open={installing} summaryClass="py-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
      {#snippet summary()}{installing ? "Installer output" : "Last installer output"}{/snippet}
      <CodeBlock class="mt-2 max-h-64" text={item.log.join("\n")} label={`${cliLabel(tool.provider)} installer output`} />
    </Disclosure>
  {/if}
</div>
