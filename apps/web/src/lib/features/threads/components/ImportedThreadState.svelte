<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { goto } from "$app/navigation";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import { continueImportedThread } from "#lib/features/imports/api.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { agentCliName } from "#lib/features/imports/labels.ts";

  /** Where the composer was: a thread imported from an agent CLI as history (docs/import.md) takes no turns. */
  let { thread, class: className }: { thread: ui.Thread; class?: ClassValue } = $props();

  let starting = $state(false);
  let error = $state("");

  /** A new thread here whose agent starts with a note about this history (docs/import.md). */
  async function continueHere() {
    starting = true;
    error = "";

    try {
      const next = await continueImportedThread(thread.id);

      if (next) await goto(`/threads/${next.id}`);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not start a new thread. Try again.";
    } finally {
      starting = false;
    }
  }

  const cli = $derived(agentCliName(thread.import?.agentCli ?? ""));
</script>

<section
  aria-label="Imported thread"
  class={[
    "flex min-h-32 flex-col justify-center gap-4 rounded-2xl bg-zinc-950/3 p-4 ring-1 ring-zinc-950/8 sm:p-5 dark:bg-white/3 dark:ring-white/8",
    className,
  ]}
>
  <div class="flex items-start gap-3">
    <Icon name="arrow-down-tray" class="h-6 text-zinc-400 dark:text-zinc-500" />
    <div class="min-w-0 flex-1">
      <h2 class="font-medium text-balance text-zinc-800 dark:text-zinc-200">Imported from {cli} as history</h2>
      <p class="pt-1 text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        This thread shows the earlier work. A new thread continues it with a summary of this history.
      </p>
    </div>
  </div>
  <div class="flex flex-wrap gap-2">
    <Button size="sm" variant="primary" icon="arrow-turn-down-right" loading={starting} onclick={continueHere}>
      Continue in a new thread
    </Button>
    <ButtonLink size="sm" href="/settings/import" icon="arrow-down-tray">Imports</ButtonLink>
  </div>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
</section>
