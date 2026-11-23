<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { workspaceImagePath } from "@canopy/domain/markdown-images";
  import { safeHref, type MarkdownImage } from "@canopy/domain/markdown";
  import { onVisualThemeChange } from "#lib/features/visuals/visual-theme.ts";
  import { useFileLinks } from "#lib/shared/ui/markdown/file-links.ts";
  import InlineLink from "#lib/shared/ui/InlineLink.svelte";

  let {
    value,
    path,
    loadImage,
    class: className,
  }: {
    value: MarkdownImage;
    path: string;
    loadImage: (path: string, href: string) => Promise<string>;
    class?: ClassValue;
  } = $props();

  const files = useFileLinks();
  let box = $state<HTMLSpanElement>();
  let source = $state("");
  let failed = $state(false);
  let dark = $state(false);

  $effect(() => {
    if (!value.darkSrc && !value.lightSrc) return;
    const read = () => (dark = document.documentElement.classList.contains("dark"));
    read();

    return onVisualThemeChange(read);
  });

  const src = $derived((dark ? value.darkSrc : value.lightSrc) ?? value.src);
  const local = $derived(workspaceImagePath(path, src));
  const href = $derived(safeHref(src));

  $effect(() => {
    const element = box;
    const resolved = local;
    const requested = src;
    const load = loadImage;
    source = "";
    failed = false;

    if (!element || !resolved) return;
    let active = true;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load(resolved, requested).then(
            (url) => {
              if (active) source = url;
            },
            () => {
              if (active) failed = true;
            },
          );
        }
      },
      { rootMargin: "200px" },
    );

    observer.observe(element);

    return () => {
      active = false;
      observer.disconnect();
    };
  });

  function imageError(event: Event): void {
    const image = event.currentTarget;

    if (image instanceof HTMLImageElement && image.getAttribute("src") === source) failed = true;
  }
</script>

<span bind:this={box} class={["inline-block max-w-full align-middle", className]}>
  {#if source && !failed}
    <img
      src={source}
      alt={value.alt}
      width={value.width}
      height={value.height}
      referrerpolicy="no-referrer"
      class="inline-block h-auto max-w-full object-contain align-middle"
      onerror={imageError}
    />
  {:else if local && files && failed}
    <InlineLink
      onactivate={() => {
        if (local) files.open(local);
      }}
      title="Could not show this image. Open the file."
      class="text-sky-700 underline focus-ring dark:text-sky-400">{value.alt || src}</InlineLink
    >
  {:else if href && !local}
    <InlineLink
      {href}
      target="_blank"
      rel="noopener noreferrer nofollow"
      class="text-sky-700 underline dark:text-sky-400">{value.alt || href}</InlineLink
    >
  {:else}
    {value.alt}
  {/if}
</span>
