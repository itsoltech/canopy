<script lang="ts">
  import { provideMemoryScope, UiMemory } from "#lib/shared/ui/memory.ts";
  import ItemView from "../components/items/ItemView.svelte";
  import { provideThreadDirectory } from "../thread-directory.ts";
  import { GALLERY_THREAD_ID, galleryThreads, toolGallery } from "./tool-fixtures.ts";

  /** Dev gallery: every kind of tool call the timeline renders, with fixture data (`/dev/tool-calls`). */
  const threads = new Map(galleryThreads().map((t) => [t.id, t]));
  provideThreadDirectory({ currentId: GALLERY_THREAD_ID, thread: (id) => threads.get(id), awaiting: () => false, goal: () => undefined });
  provideMemoryScope("gallery", new UiMemory());
  const groups = toolGallery();
</script>

<main class="mx-auto grid max-w-3xl gap-10 px-4 py-10 sm:px-6">
  <h1 class="text-xl font-semibold text-zinc-950 dark:text-white">Tool calls</h1>
  {#each groups as group (group.title)}
    <section class="grid gap-1" aria-label={group.title}>
      <h2 class="mb-2 text-base/6 font-medium text-zinc-500 dark:text-zinc-400">{group.title}</h2>
      {#each group.items as entry (entry.itemId)}
        <div data-gallery-item={entry.itemId}><ItemView item={entry} /></div>
      {/each}
    </section>
  {/each}
</main>
