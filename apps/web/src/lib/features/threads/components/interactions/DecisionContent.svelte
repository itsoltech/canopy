<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    children,
    actions,
    label,
    moreLabel = "More details below",
    class: className,
  }: { children: Snippet; actions: Snippet; label: string; moreLabel?: string; class?: ClassValue } = $props();

  let viewport = $state<HTMLDivElement>();
  let more = $state(false);
  let overflowing = $state(false);

  const measure: Attachment<HTMLDivElement> = (node) => {
    const update = () => {
      if (!viewport) return;

      overflowing = viewport.scrollHeight - viewport.clientHeight > 2;
      more = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 2;
    };

    const observer = new ResizeObserver(update);

    observer.observe(node);

    if (viewport) observer.observe(viewport);

    viewport?.addEventListener("scroll", update);
    update();

    return () => {
      observer.disconnect();
      viewport?.removeEventListener("scroll", update);
    };
  };
</script>

<div class={["flex min-h-0 flex-col", className]}>
  <!-- A named scroll region needs keyboard focus for Page Up/Down and arrow-key reading. -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    bind:this={viewport}
    class="min-h-0 scroll-stable overflow-y-auto overscroll-contain focus-ring"
    role="region"
    aria-label={label}
    tabindex="0"
  >
    <div {@attach measure}>{@render children()}</div>
  </div>
  {#if overflowing}
    <div class="shrink-0 border-t border-zinc-950/10 bg-zinc-50 px-3 dark:border-white/10 dark:bg-zinc-900">
      <Button
        variant="ghost"
        size="sm"
        icon={more ? "chevron-down" : "arrow-uturn-left"}
        class="w-full"
        onclick={() =>
          viewport?.scrollBy({
            top: more ? viewport.clientHeight * 0.75 : -viewport.scrollHeight,
            behavior: "instant",
          })}>{more ? moreLabel : "Back to start"}</Button
      >
    </div>
  {/if}
  <div class="shrink-0 border-t border-zinc-950/10 dark:border-white/10">{@render actions()}</div>
</div>
