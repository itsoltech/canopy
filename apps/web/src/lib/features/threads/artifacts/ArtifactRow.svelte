<script lang="ts">
  import type { Item } from "@canopy/contracts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { artifactTitle, artifactDetail } from "./artifact-meta.ts";
  import PanelRow from "../components/PanelRow.svelte";

  let { item, onclick }: { item: Item; onclick: () => void } = $props();
  const content = $derived(item.content);

  const thumbId = $derived.by(() => {
    if (content.case === "imageGallery") {
      const first = content.value.images[0];

      return first?.hasThumbnail ? first.attachmentId : "";
    }

    if (content.case === "publishedVideo" && content.value.attachment?.hasThumbnail) return content.value.attachment.id;

    return "";
  });

  const icon = $derived(content.case === "visual" ? "window" : content.case === "publishedVideo" ? "play" : "photo");
  const title = $derived(artifactTitle(item));
</script>

<PanelRow {icon} {onclick} class="py-1">
  {#snippet lead()}
    <span
      class="relative grid h-8 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-zinc-950/5 text-muted dark:bg-white/8"
    >
      <Icon name={icon} />
      {#if thumbId}
        {#key thumbId}
          <img
            src="/api/attachments/{encodeURIComponent(thumbId)}?thumbnail"
            alt=""
            loading="lazy"
            decoding="async"
            class="absolute inset-0 size-full object-cover"
            onerror={(event) => event.currentTarget.setAttribute("hidden", "")}
          />
        {/key}
      {/if}
    </span>
  {/snippet}
  <span class="block truncate font-medium" {title}>{title}</span>
  <span class="block truncate text-sm/5 text-muted sm:text-xs/4">{artifactDetail(item)}</span>
</PanelRow>
