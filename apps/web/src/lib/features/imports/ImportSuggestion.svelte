<script lang="ts">
  import { onMount } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { rise } from "#lib/shared/ui/motion.ts";
  import { dismissSuggestion, suggestionDismissed, suggestionScan, suggestionText } from "./import-suggestion.ts";

  /**
   * First run (docs/import.md): with no threads yet and an online worker of this computer that can import, one
   * card offers the CLI threads found on it. It floats at the bottom, so nothing above it moves when it appears.
   */
  let { class: className }: { class?: ClassValue } = $props();
  const overview = useOverview();
  let dismissed = $state(true);
  let text = $state<ReturnType<typeof suggestionText>>();

  onMount(() => {
    dismissed = suggestionDismissed();
  });

  const worker = $derived(
    overview.threads.size === 0
      ? overview.workers.find((w) => !w.nodeId && w.online && !w.revokedAt && w.cliImport)
      : undefined,
  );

  $effect(() => {
    text = undefined;

    if (dismissed || !worker) return;
    let current = true;
    const { id } = worker;

    void suggestionScan(id).then((scan) => {
      if (current) text = scan ? suggestionText(scan.overview) : undefined;
    });

    return () => {
      current = false;
    };
  });

  function dismiss() {
    dismissSuggestion();
    dismissed = true;
  }
</script>

{#if worker && text && !dismissed}
  <!-- Hidden on very short screens, where it would cover the composer. -->
  <div
    class={[
      "pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4 sm:px-6 [@media(max-height:599px)]:hidden",
      className,
    ]}
  >
    <div
      class="pointer-events-auto flex w-full max-w-(--chat-width) flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-white py-2.5 pr-2 pl-4 shadow-lg ring-1 ring-zinc-950/10 dark:bg-zinc-900 dark:shadow-none dark:ring-white/10"
      role="status"
      transition:rise
    >
      <div class="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-0 sm:items-center">
        <Icon name="arrow-down-tray" class="mt-1 size-5 shrink-0 text-zinc-500 sm:mt-0 sm:size-4 dark:text-zinc-400" />
        <p class="min-w-0 flex-1 text-base/6 text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
          {text.prefix}
          <span class="inline-block max-w-32 align-bottom sm:max-w-48"><TruncatedText text={worker.name} /></span>
          {text.suffix}
        </p>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <ButtonLink href={`/settings/import?worker=${encodeURIComponent(worker.id)}`} variant="primary"
          >Import</ButtonLink
        >
        <IconButton icon="x-mark" label="Dismiss the import suggestion" onclick={dismiss} />
      </div>
    </div>
  </div>
{/if}
