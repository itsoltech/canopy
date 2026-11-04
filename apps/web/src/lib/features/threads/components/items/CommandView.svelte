<script lang="ts">
  import { ItemStatus, type CommandExecution } from "@canopy/contracts";
  import { formatDuration } from "#lib/shared/format.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import ItemFrame from "./ItemFrame.svelte";
  import OutputBlock from "./OutputBlock.svelte";

  /** Shell command: command line, exit code, duration; output streams in while it runs. */
  let {
    command,
    status,
    streaming = false,
  }: { command: CommandExecution; status: ItemStatus; streaming?: boolean } = $props();
</script>

<ItemFrame icon="command-line" {status}>
  {#snippet title()}
    <code class="block truncate font-mono text-xs/6 text-zinc-800 dark:text-zinc-200" title={command.command}
      >{command.command.split("\n")[0]}</code
    >
  {/snippet}
  {#snippet aside()}
    {#if command.durationMs > 0n}<span>{formatDuration(command.durationMs)}</span>{/if}
    {#if command.exitCode !== undefined}<Badge tone={command.exitCode === 0 ? "emerald" : "rose"}
        >exit {command.exitCode}</Badge
      >{/if}
  {/snippet}
  {#if command.command.includes("\n")}
    <pre
      data-quote-kind="code"
      data-quote-lang="sh"
      class="code-surface rounded-lg bg-zinc-950/2.5 p-3 text-zinc-950 dark:bg-white/5 dark:text-white">{command.command}</pre>
  {/if}
  {#if command.cwd}<p class="truncate font-mono text-xs/5 text-zinc-500 dark:text-zinc-400" title={command.cwd}>
      in {command.cwd}
    </p>{/if}
  <OutputBlock
    quoteKind="command_output"
    output={command.output}
    blob={command.outputBlob}
    label="Output of {command.command.split('\n')[0]}"
    empty={status === ItemStatus.IN_PROGRESS ? "Waiting for output…" : "No output."}
    {streaming}
  />
</ItemFrame>
