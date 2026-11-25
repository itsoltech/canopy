<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DiffLines from "#lib/shared/ui/code/DiffLines.svelte";
  import type { ChatEventView } from "@canopy/domain/bot-chat";
  import { unifiedTextDiff } from "@canopy/domain/text-diff";

  let {
    open = $bindable(false),
    event,
    class: className,
  }: {
    open?: boolean;
    event: ChatEventView;
    class?: ClassValue;
  } = $props();

  function instructionDiff(before: string, after: string) {
    // Give the final logical line a terminator so appending does not mark it as replaced.
    return unifiedTextDiff(before && `${before}\n`, after && `${after}\n`, 1);
  }
</script>

<Dialog bind:open title="Bot settings changed" description={event.text} size="lg" stickyHeader class={className}>
  <dl class="grid gap-5">
    {#each event.changes ?? [] as change (change.field)}
      {@const review = change.field === "instructions" ? instructionDiff(change.before, change.after) : undefined}
      <div class="grid gap-2">
        <dt class="text-base font-medium capitalize sm:text-sm">{change.field}</dt>
        <dd class="min-w-0">
          {#if review?.kind === "text" && review.diff}
            <DiffLines
              diff={review.diff}
              prose
              class="overflow-hidden rounded-lg border border-divider bg-zinc-950/2.5 text-base/6 select-text sm:text-sm/6 dark:bg-white/4"
            />
          {:else}
            {#if review?.kind === "large"}
              <p class="mb-2 text-base text-muted sm:text-sm">
                This change is too large to show as a diff. Compare the full instructions below.
              </p>
            {/if}
            <div class={["grid items-start gap-3", !review && "sm:grid-cols-2"]}>
              {#each [{ label: "Before", value: change.before }, { label: "After", value: change.after }] as version (version.label)}
                <div class="grid min-w-0 gap-1 text-base/6 sm:text-sm/6">
                  <p class="text-muted">{version.label}</p>
                  <p class="rounded-lg bg-zinc-950/4 p-3 wrap-anywhere whitespace-pre-wrap select-text dark:bg-white/5">
                    {version.value || "Not set"}
                  </p>
                </div>
              {/each}
            </div>
          {/if}
        </dd>
      </div>
    {/each}
  </dl>
</Dialog>
