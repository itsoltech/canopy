<script lang="ts">
  import type { AnimationConfig } from "svelte/animate";
  import type { ClassValue } from "svelte/elements";
  import { expand, reorder } from "#lib/shared/ui/motion.ts";
  import { QueueDrag } from "./queue-drag.svelte.ts";
  import type { QueueState } from "./queue-state.svelte.ts";
  import QueueRow from "./QueueRow.svelte";
  import ComposerPanelHeader from "../components/ComposerPanelHeader.svelte";
  import ComposerPanelBody from "../components/ComposerPanelBody.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * The queued messages, attached above the composer: the composer's surface with only its
   * top corners rounded, sliding under the composer's top edge (`class` sets the overlap). One row per message in
   * the order they run. Rows glide to a new place (`reorder`, FLIP), grow in and shrink out (`expand`); the row
   * under the pointer follows it instead. Moves are announced politely.
   */
  let {
    queue,
    delivery,
    ondelivery,
    embedded = false,
    compact = false,
    class: className,
  }: {
    queue: QueueState;
    delivery: "steer" | "queue";
    ondelivery: (delivery: "steer" | "queue") => void;
    embedded?: boolean;
    compact?: boolean;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let open = $state(true);
  const expanded = $derived(open && !compact);

  let list = $state<HTMLOListElement>();

  const drag = new QueueDrag({
    list: () => list,
    onmove: (id, index) => queue.preview(id, index),
    ondrop: (id) => {
      queue.announce(queue.rows.findIndex((t) => t.id === id));
      void queue.commit();
    },
  });

  /** The dragged row is placed by the pointer, not by the glide. */
  const glide = (
    node: Element,
    positions: { from: DOMRect; to: DOMRect },
    { held }: { held: boolean },
  ): AnimationConfig => (held ? { duration: 0 } : reorder(node, positions));
</script>

{#if queue.rows.length > 0}
  <section
    aria-label="Queued messages"
    class={[
      !embedded && "rounded-t-2xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10",
      className,
    ]}
  >
    <ComposerPanelHeader {expanded} controls="{id}-queue" onclick={(wasExpanded) => (open = !wasExpanded)}>
      <Icon name="queue-list" size="sm" />
      <p class="min-w-0 flex-1 truncate text-zinc-700 tabular-nums dark:text-zinc-300">{queue.rows.length} queued</p>
    </ComposerPanelHeader>
    <ComposerPanelBody id="{id}-queue" open={expanded}>
      <ol bind:this={list} role="list" class="relative grid grid-cols-1 py-1">
        {#each queue.rows as turn, index (turn.id)}
          <li data-queue-row class="relative" animate:glide={{ held: drag.id === turn.id }} transition:expand>
            <QueueRow
              {turn}
              {index}
              count={queue.rows.length}
              running={queue.running}
              fallback={queue.fallback(turn.id)}
              editing={queue.editing === turn.id}
              dragging={drag.id === turn.id}
              offset={drag.id === turn.id ? drag.offset : 0}
              {delivery}
              onmove={(to) => void queue.move(turn.id, to)}
              ondragstart={(event) => drag.start(event, turn.id)}
              onsteer={() => void queue.steer(turn)}
              ondelete={() => void queue.remove(turn)}
              onedit={() => (queue.editing = turn.id)}
              onsave={(text, mentions) => queue.edit(turn, text, mentions)}
              oncancel={() => (queue.editing = undefined)}
              {ondelivery}
            />
          </li>
        {/each}
      </ol>
    </ComposerPanelBody>
    <p class="sr-only" role="status">{queue.announcement}</p>
  </section>
{/if}
