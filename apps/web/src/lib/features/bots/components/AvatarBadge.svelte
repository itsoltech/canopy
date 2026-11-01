<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { AvatarSize } from "./BotAvatar.svelte";

  /**
   * Badge in the bottom-right corner of an avatar (the parent is `relative`): a star for pinned, a
   * dot for online. Ringed in the surface colour (`--avatar-ring`, default white / black).
   */
  let { kind, size = "md", class: className }: { kind: "pinned" | "online"; size?: AvatarSize; class?: ClassValue } = $props();

  const ring = "ring-2 ring-[var(--avatar-ring,var(--color-white))] dark:ring-[var(--avatar-ring,var(--color-black))]";
  const star: Record<AvatarSize, { box: string; icon: string }> = {
    xs: { box: "size-2.5", icon: "size-2" },
    sm: { box: "size-3", icon: "size-2" },
    md: { box: "size-4", icon: "size-3" },
    lg: { box: "size-5", icon: "size-3.5" },
    xl: { box: "size-6", icon: "size-4" },
  };
</script>

{#if kind === "pinned"}
  <span class={["absolute -right-0.5 -bottom-0.5 grid place-items-center rounded-full bg-orange-500", ring, star[size].box, className]}>
    <Icon name="star" class={["fill-white", star[size].icon]} />
  </span>
{:else}
  <span class={["absolute right-0 bottom-0 size-1/4 min-w-2 rounded-full bg-emerald-500", ring, className]}></span>
{/if}
