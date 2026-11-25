<script lang="ts">
  import type { Snippet } from "svelte";
  import { segmentedItem, segmentedPill, segmentedTrack } from "#lib/shared/ui/segmented.ts";
  import { useSettingsRoute } from "./settings-route.ts";
  import { useSettingsSearch } from "./settings-search.ts";

  interface Topic {
    id: string;
    label: string;
    content: Snippet;
    keywords?: string;
    hidden?: boolean | undefined;
  }

  let { topics, label, defaultTopic }: { topics: readonly Topic[]; label: string; defaultTopic?: string | undefined } =
    $props();

  const prefix = $props.id();
  const route = useSettingsRoute();
  const search = useSettingsSearch();
  const visible = $derived(topics.filter((topic) => !topic.hidden));
  let picked = $state<{ query: string; hash: string }>();
  const linked = $derived(visible.find((topic) => route.url.hash === `#topic-${topic.id}`));
  const matched = $derived(visible.find((topic) => search.panel === `${prefix}-${topic.id}`));
  const manual = $derived(picked?.query === search.query && picked.hash === route.url.hash);

  const active = $derived(
    (manual ? linked : undefined) ??
      (search.query && !defaultTopic ? matched : undefined) ??
      linked ??
      visible.find((topic) => topic.id === defaultTopic) ??
      visible[0],
  );

  function select(topic: Topic) {
    const hash = `#topic-${topic.id}`;
    picked = { query: search.query, hash };
    void route.selectTopic(hash);
  }

  export function selectTopic(id: string) {
    const topic = visible.find((candidate) => candidate.id === id);

    if (!topic) return;
    select(topic);
    document.getElementById(`${prefix}-${topic.id}-tab`)?.focus();
  }

  function keydown(event: KeyboardEvent, index: number) {
    const offset = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;

    if (!offset && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const last = visible.length - 1;

    const next =
      event.key === "Home" ? 0 : event.key === "End" ? last : (index + offset + visible.length) % visible.length;

    const topic = visible[next];

    if (topic) selectTopic(topic.id);
  }
</script>

{#if visible.length > 1 && active}
  <div class="topic-picker">
    <div
      role="tablist"
      aria-label={label}
      class={["topic-tabs relative flex w-fit max-w-full flex-wrap", segmentedTrack]}
      style:--count={visible.length}
      style:--at={visible.indexOf(active)}
    >
      <span aria-hidden="true" class={["topic-pill t-tabs-pill", segmentedPill]}></span>
      {#each visible as topic, index (topic.id)}
        {@const panel = `${prefix}-${topic.id}`}
        <button
          type="button"
          role="tab"
          id={`${panel}-tab`}
          data-settings-topic={panel}
          aria-controls={panel}
          aria-selected={topic === active}
          tabindex={topic === active ? 0 : -1}
          data-active={topic === active || undefined}
          onclick={() => select(topic)}
          onkeydown={(event) => keydown(event, index)}
          class={[segmentedItem, "min-h-(--settings-target)"]}>{topic.label}</button
        >
      {/each}
    </div>
  </div>
{/if}

{#each visible as topic (topic.id)}
  {@const panel = `${prefix}-${topic.id}`}
  <div
    id={panel}
    role={visible.length > 1 ? "tabpanel" : undefined}
    aria-labelledby={visible.length > 1 ? `${panel}-tab` : undefined}
    data-settings-topic={panel}
    data-topic-keywords={topic.keywords}
    hidden={topic !== active}
    class="min-w-0"
  >
    <div class="settings-stack">{@render topic.content()}</div>
  </div>
{/each}

<style>
  .topic-picker {
    container: topic-picker / inline-size;
  }

  .topic-tabs button {
    flex: auto;
  }

  .topic-tabs button[aria-selected="true"] {
    color: var(--color-ink);
  }

  .topic-pill {
    display: none;
  }

  @container topic-picker (max-width: 26rem) {
    .topic-tabs:has(button:nth-of-type(4):last-child) {
      display: grid;
      width: 100%;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @container topic-picker (min-width: 36rem) {
    .topic-tabs {
      display: grid;
      grid-template-columns: repeat(var(--count), minmax(0, 1fr));
    }

    .topic-pill {
      display: block;
      width: calc((100% - (var(--count) + 1) * var(--spacing) * 0.5) / var(--count));
      translate: calc(var(--at) * (100% + var(--spacing) * 0.5)) 0;
    }

    .topic-tabs button[data-active] {
      background: transparent;
      box-shadow: none;
    }
  }
</style>
