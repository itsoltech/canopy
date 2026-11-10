<script lang="ts">
  import type { ShellResult } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import CodeBlock from "#lib/shared/ui/CodeBlock.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";

  let {
    command,
    result,
    status = "queued",
    reason = "",
    pending = false,
    class: className,
  }: {
    command: string;
    result?: ShellResult | undefined;
    status?: string;
    reason?: string;
    pending?: boolean;
    class?: ClassValue;
  } = $props();

  let expanded = $state(false);
  const running = $derived(result?.status === "running");
  const success = $derived(result?.status === "completed" && result.exitCode === 0);
  const lines = $derived(result?.output.split("\n") ?? []);
  const preview = $derived(lines.slice(0, 4).join("\n"));
  const failed = $derived((result?.status ?? status) === "failed");
  const interrupted = $derived((result?.status ?? status) === "interrupted");
  const failureReason = $derived(result?.reason || (failed ? reason : ""));
</script>

<div class={["flex min-w-0 justify-end", className]}>
  <div
    class={[
      "grid w-full max-w-[min(95%,42rem)] min-w-0 grid-cols-1 gap-2 rounded-2xl rounded-br-md bg-rose-50/70 px-4 py-3 ring-1 ring-rose-600/20 ring-inset dark:bg-rose-400/5 dark:ring-rose-400/25",
      pending && "opacity-70",
    ]}
  >
    <div class="flex flex-wrap items-center justify-between gap-2 text-xs/5">
      <p class="flex min-w-0 items-center gap-1.5 text-rose-700 dark:text-rose-300">
        <Icon name="command-line" tone="inherit" class="size-3.5 shrink-0" />Shell command
      </p>
      <p
        class={[
          "flex shrink-0 items-center gap-1.5 rounded-md px-1.5 tabular-nums",
          success
            ? "bg-emerald-600/10 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300"
            : "bg-rose-600/10 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300",
        ]}
        role="status"
      >
        {#if running}<Spinner
            class="size-3"
          />Running…{:else if interrupted}Interrupted{:else if failed}Failed{:else if result?.exitCode !== undefined}Exit
          {result.exitCode}{:else}Queued{/if}
      </p>
    </div>
    <pre
      class="min-w-0 font-mono text-base/6 wrap-anywhere whitespace-pre-wrap text-zinc-950 sm:text-sm/6 dark:text-zinc-100">{command}</pre>
    {#if failureReason}<p class="text-sm/5 text-rose-700 select-text sm:text-xs/5 dark:text-rose-300">
        {failureReason}
      </p>{/if}
    {#if result && !running}
      {#if result.output}
        {#if !expanded}<pre
            class="line-clamp-4 min-w-0 font-mono text-sm/5 wrap-anywhere whitespace-pre-wrap text-zinc-600 sm:text-xs/5 dark:text-zinc-400">{preview}</pre>{/if}
        <Disclosure bind:open={expanded} summaryClass="text-sm/5 text-rose-700 sm:text-xs/5 dark:text-rose-300">
          {#snippet summary()}{expanded ? "Hide output" : "Show output"}{/snippet}
          <CodeBlock text={result.output} label="Shell output" class="mt-2" />
        </Disclosure>
      {:else}<p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">No output</p>{/if}
    {/if}
  </div>
</div>
