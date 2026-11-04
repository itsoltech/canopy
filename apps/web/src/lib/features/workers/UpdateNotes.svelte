<script lang="ts">
  import { Schema } from "effect";
  import type { ClassValue } from "svelte/elements";
  import { requestJson } from "#lib/shared/http.ts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import UpdateReleaseNotes from "#lib/features/desktop/UpdateReleaseNotes.svelte";

  let {
    current,
    target,
    channel,
    source = "canopy",
    expanded = false,
    class: className,
  }: {
    current: string;
    target: string;
    channel: string;
    source?: "canopy" | "claude" | "codex";
    expanded?: boolean;
    class?: ClassValue;
  } = $props();

  let open = $state(false);
  let notes = $state<{ version: string; markdown: string }[]>();
  let error = $state("");
  let retry = $state(0);

  const query = $derived(
    current && target && current !== target ? new URLSearchParams({ current, target, channel, source }).toString() : "",
  );

  $effect(() => {
    if (expanded) open = true;
  });

  $effect(() => {
    if (!open || !query) return;
    void retry;
    let active = true;
    error = "";
    notes = undefined;
    void requestJson("GET", `/api/updates/notes?${query}`, undefined, 120_000)
      .then((value) => {
        if (!active) return;
        notes = [
          ...Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ version: Schema.String, markdown: Schema.String })))(
            value,
          ),
        ];
      })
      .catch((cause: Error) => {
        if (!active) return;
        error = cause instanceof Error ? cause.message : "Release notes could not be loaded";
      });

    return () => {
      active = false;
    };
  });
</script>

{#if current && target && current !== target}
  <Disclosure bind:open class={className} summaryClass="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
    {#snippet summary()}Release notes · {current} → {target}{/snippet}
    <div class="pt-4">
      {#if error}<Alert tone="error"
          >{error}{#snippet actions()}<Button size="sm" onclick={() => retry++}>Retry</Button>{/snippet}</Alert
        >
      {:else if notes}<UpdateReleaseNotes releases={notes} {channel} {source} />
      {:else}<p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400" role="status">
          Loading release notes…
        </p>{/if}
    </div>
  </Disclosure>
{/if}
