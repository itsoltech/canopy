<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { githubImageUrl, type GitHubImage } from "@canopy/domain/github-images";
  import { safeHref } from "@canopy/domain/markdown";
  import { image } from "./api.ts";

  let {
    value,
    pullRequestId,
    contentId,
    class: className,
  }: {
    value: GitHubImage;
    pullRequestId: string;
    contentId: string;
    class?: ClassValue;
  } = $props();

  let box: HTMLSpanElement;
  let visible = $state(false);
  let source = $state("");
  let failed = $state(false);
  const small = $derived(!!value.width && !!value.height && value.width <= 64 && value.height <= 64);
  const width = $derived(value.width ?? 800);
  const height = $derived(value.height ?? (value.width ? (value.width * 9) / 16 : 450));
  const allowed = $derived(githubImageUrl(value.src));
  const href = $derived(safeHref(value.src));

  $effect(() => {
    if (!box || small) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) visible = true;
      },
      { rootMargin: "200px" },
    );

    observer.observe(box);

    return () => observer.disconnect();
  });

  $effect(() => {
    const url = allowed,
      pr = pullRequestId,
      content = contentId;

    source = "";
    failed = false;

    if (!url || (!small && !visible)) return;
    let active = true;
    void image(pr, content, url)
      .then((result) => {
        if (active) source = result.dataUrl;
      })
      .catch(() => {
        if (active) failed = true;
      });

    return () => {
      active = false;
    };
  });
</script>

<span
  bind:this={box}
  class={[
    "relative inline-block max-w-full overflow-hidden align-middle",
    !small && "rounded bg-zinc-500/5",
    className,
  ]}
  style:width={`${width}px`}
  style:aspect-ratio={`${width} / ${height}`}
>
  {#if !allowed || failed}
    {#if href}<a
        {href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        class="absolute inset-0 grid place-items-center overflow-auto text-sm text-sky-700 underline dark:text-sky-400"
        >{value.alt || "Open image"}</a
      >
    {:else}<span class="absolute inset-0">{value.alt}</span>{/if}
  {:else if source}
    <img
      src={source}
      alt={value.alt}
      {width}
      {height}
      loading={small ? "eager" : "lazy"}
      referrerpolicy="no-referrer"
      class="absolute inset-0 size-full object-contain"
      onerror={() => {
        failed = true;
      }}
    />
  {/if}
</span>
