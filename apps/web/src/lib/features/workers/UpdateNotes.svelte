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
  import UpdateReleaseNotes from "#lib/features/desktop/UpdateReleaseNotes.svelte";

  let {
    current,
    target,
    channel,
    desktopReleases,
  }: {
    current: string;
    target: string;
    channel: string;
    desktopReleases: readonly ReleaseNote[];
  } = $props();

  let notes = $state<ReleaseNote[]>([]);

  const query = $derived(
    current && target && current !== target ? new URLSearchParams({ current, target, channel }).toString() : "",
  );

  const desktopVersions = $derived(new Set(desktopReleases.map((release) => release.version)));
  const gatewayReleases = $derived(notes.filter((release) => !desktopVersions.has(release.version)));

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

{#if gatewayReleases.length}
  <UpdateReleaseNotes releases={gatewayReleases} title={`Gateway releases · ${channel}`} />
{/if}
