<script module lang="ts">
  import { Schema } from "effect";
  import { requestJson } from "#lib/shared/http.ts";

  type ReleaseNote = { version: string; markdown: string };

  const cache = new Map<string, { at: number; value: Promise<ReleaseNote[]> }>();

  function loadNotes(query: string): Promise<ReleaseNote[]> {
    const cached = cache.get(query);

    if (cached && Date.now() - cached.at < 60000) return cached.value;

    const value = requestJson("GET", `/api/updates/notes?${query}`, undefined, 120000).then((response) =>
      [
        ...Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ version: Schema.String, markdown: Schema.String })))(
          response,
        ),
      ].filter((note) => !!note.markdown.trim()),
    );

    if (cache.size >= 100) cache.clear();
    cache.set(query, { at: Date.now(), value });

    return value;
  }
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import UpdateReleaseNotes from "#lib/features/desktop/UpdateReleaseNotes.svelte";

  let {
    current,
    target,
    channel,
    source = "canopy",
    expanded = false,
    compact = false,
    class: className,
  }: {
    current: string;
    target: string;
    channel: string;
    source?: "canopy" | "claude" | "codex";
    expanded?: boolean;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

  let notes = $state<ReleaseNote[]>([]);

  const query = $derived(
    current && target && current !== target ? new URLSearchParams({ current, target, channel, source }).toString() : "",
  );

  $effect(() => {
    notes = [];

    if (!query) return;
    let active = true;
    void loadNotes(query)
      .then((value) => {
        if (active) notes = value;
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  });
</script>

{#if notes.length}
  <Disclosure open={expanded} class={className} summaryClass="py-1 text-sm/5 text-muted">
    {#snippet summary()}{#if compact}What’s new{:else}Release notes · {current} → {target}{/if}{/snippet}
    <div class={["break-anywhere pt-2", compact && "max-h-60 scroll-stable overflow-y-auto overscroll-contain"]}>
      <UpdateReleaseNotes releases={notes} {channel} {source} />
    </div>
  </Disclosure>
{/if}
