<script lang="ts">
  import type { UsageData } from "./format.ts";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";

  let { computers }: { computers: UsageData["computers"] } = $props();
  const date = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));

  const time = (value: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

  const statuses = new Map([
    ["ready", "Up to date"],
    ["syncing", "Syncing"],
    ["unsupported", "Update required"],
    ["relay", "Direct link required"],
    ["stale", "Last recorded usage"],
    ["offline", "Offline"],
  ]);

  const nextSteps = new Map([
    ["syncing", "Refresh after syncing finishes."],
    ["unsupported", "Update Canopy on this computer to record usage."],
    ["relay", "Connect this computer directly to include its usage."],
    ["stale", "Refresh when the connection recovers."],
    ["offline", "Refresh when this computer reconnects."],
  ]);
</script>

{#if computers.length}
  <details class="rounded-xl border border-divider text-sm/5">
    <summary class="cursor-pointer rounded-xl px-4 py-3 font-medium focus-ring">Recording coverage</summary>
    <div class="grid gap-3 border-t border-divider p-4">
      <p class="text-zinc-500 dark:text-zinc-400">Only recorded usage appears here. Earlier activity may be missing.</p>
      <ul class="grid gap-3">
        {#each computers as computer (computer.id)}
          <li class="min-w-0">
            <div class="flex min-w-0 items-center justify-between gap-3">
              <TruncatedText text={computer.name} class="font-medium" />
              <span class="shrink-0 text-zinc-500 dark:text-zinc-400">{statuses.get(computer.status) ?? "Pending"}</span
              >
            </div>
            <p class="text-zinc-500 dark:text-zinc-400">
              {computer.trackingSince ? `Recording since ${date(computer.trackingSince)}.` : ""}
              {#if computer.updatedAt}
                Last report {time(computer.updatedAt)}.{/if}
            </p>
            {#if nextSteps.has(computer.status)}
              <p class="text-zinc-500 dark:text-zinc-400">{nextSteps.get(computer.status)}</p>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  </details>
{/if}
