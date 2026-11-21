<script lang="ts">
  import type { Snippet } from "svelte";

  let { children, centered = false }: { children: Snippet; centered?: boolean } = $props();
</script>

<div class="relative isolate flex h-full min-h-0 flex-col bg-canvas text-ink">
  <div class="hidden h-(--window-titlebar-height) shrink-0 desktop:block" data-window-drag></div>
  <div class="min-h-0 flex-1 scroll-stable overflow-y-auto overscroll-contain">
    <div class="mx-auto flex min-h-full w-full max-w-2xl flex-col px-6 pt-8 pb-12 sm:px-10 sm:pt-10">
      <div class={["grid min-w-0 gap-6 wrap-anywhere", centered && "my-auto"]}>
        {@render children()}
      </div>
    </div>
  </div>
</div>
