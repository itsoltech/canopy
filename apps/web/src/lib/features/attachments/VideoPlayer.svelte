<script lang="ts">
  let { src, poster, active = true }: { src: string; poster?: string | undefined; active?: boolean } = $props();
  let video = $state<HTMLVideoElement>();
  let failed = $state(false);

  $effect(() => {
    const node = video;

    if (!node) return;

    if (!active) node.pause();

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
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  });

  function keydown(event: KeyboardEvent) {
    const node = video;

    if (!node || event.target !== node || ![" ", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === " ") {
      if (node.paused) void node.play().catch(() => (failed = true));
      else node.pause();
    } else if (Number.isFinite(node.duration)) {
      node.currentTime = Math.max(0, Math.min(node.duration, node.currentTime + (event.key === "ArrowLeft" ? -5 : 5)));
    }
  }
</script>

<div class="grid gap-2 bg-zinc-950 text-white">
  <!-- svelte-ignore a11y_media_has_caption -- user supplied files have no platform-generated captions; native controls stay available -->
  <video
    bind:this={video}
    {src}
    {poster}
    controls
    playsinline
    preload="metadata"
    muted
    tabindex="0"
    aria-label="Video player"
    onkeydown={keydown}
    onerror={() => (failed = true)}
    class="max-h-[calc(var(--window-safe-height)-11rem)] w-[min(90vw,64rem)] rounded-lg object-contain sm:max-h-[calc(var(--window-safe-height)-8rem)]"
  ></video>
  {#if failed}
    <p role="alert" class="px-3 pb-3 text-base sm:text-sm">
      Could not play this video. Download it to open it in another app.
    </p>
  {/if}
</div>
