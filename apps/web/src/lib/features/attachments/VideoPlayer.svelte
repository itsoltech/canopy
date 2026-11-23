<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";

  let {
    src,
    poster,
    active = true,
    embedded = false,
    label = "Video player",
  }: { src: string; poster?: string | undefined; active?: boolean; embedded?: boolean; label?: string } = $props();

  let video = $state<HTMLVideoElement>();
  let failed = $state(false);

  $effect(() => {
    if (!active) video?.pause();
  });

  $effect(() => {
    const node = video;

    if (!node) return;

    const visibility = () => {
      if (document.hidden) node.pause();
    };

    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) node.pause();
    });

    observer.observe(node);
    document.addEventListener("visibilitychange", visibility);

    return () => {
      node.pause();

      if (embedded) {
        node.removeAttribute("src");
        node.load();
      }

      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  });

  function keydown(event: KeyboardEvent) {
    const node = video;

    if (!node || event.target !== node || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    if (Number.isFinite(node.duration)) {
      node.currentTime = Math.max(0, Math.min(node.duration, node.currentTime + (event.key === "ArrowLeft" ? -5 : 5)));
    }
  }
</script>

<div
  class={embedded
    ? "flex h-full min-h-0 min-w-0 flex-col items-center justify-center gap-2 p-3"
    : "grid gap-2 bg-zinc-950 text-white"}
>
  <!-- svelte-ignore a11y_media_has_caption -- user supplied files have no platform-generated captions; native controls stay available -->
  <video
    bind:this={video}
    {src}
    {poster}
    controls
    playsinline
    preload="metadata"
    muted={!embedded}
    tabindex="0"
    aria-label={label}
    onkeydowncapture={keydown}
    onplaying={() => (failed = false)}
    onerror={() => (failed = true)}
    class={embedded
      ? "max-h-full min-h-0 w-full max-w-5xl rounded-lg bg-zinc-950 object-contain"
      : "max-h-[calc(var(--window-safe-height)-11rem)] w-[min(90vw,64rem)] rounded-lg object-contain sm:max-h-[calc(var(--window-safe-height)-8rem)]"}
  ></video>
  {#if failed && embedded}
    <div class="flex flex-wrap items-center justify-center gap-2">
      <p role="alert" class="text-base text-muted sm:text-sm">Could not play this video.</p>
      <Button
        size="sm"
        onclick={() => {
          failed = false;
          video?.load();
          video?.focus();
        }}>Retry</Button
      >
    </div>
  {:else if failed}
    <p role="alert" class="px-3 pb-3 text-base sm:text-sm">
      Could not play this video. Download it to open it in another app.
    </p>
  {/if}
</div>
