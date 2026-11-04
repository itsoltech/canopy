<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import type { ChatEventView } from "../model.ts";

  let {
    open = $bindable(false),
    event,
    class: className,
  }: {
    open?: boolean;
    event: ChatEventView;
    class?: ClassValue;
  } = $props();
</script>

<Dialog bind:open title="Bot settings changed" description={event.text} size="lg" class={className}>
  <dl class="grid gap-5">
    {#each event.changes ?? [] as change (change.field)}
      <div class="grid gap-2">
        <dt class="text-base font-medium capitalize sm:text-sm">{change.field}</dt>
        <dd class="grid min-w-0 gap-3 sm:grid-cols-2">
          {#each [{ label: "Before", value: change.before }, { label: "After", value: change.after }] as version (version.label)}
            <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
              <p class="text-zinc-500 dark:text-zinc-400">{version.label}</p>
              <p class="rounded-lg bg-zinc-950/4 p-3 wrap-anywhere whitespace-pre-wrap dark:bg-white/5">
                {version.value || "Not set"}
              </p>
            </div>
          {/each}
        </dd>
      </div>
    {/each}
  </dl>
</Dialog>
