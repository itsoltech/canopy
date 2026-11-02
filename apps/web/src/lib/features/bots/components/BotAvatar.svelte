<script lang="ts" module>
  export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { mascotFor, type BotAppearance } from "../mascot.ts";
  import type { ParticipantView } from "../model.ts";
  import AvatarBadge from "./AvatarBadge.svelte";
  import MascotFace from "./MascotFace.svelte";
  import type { MascotState } from "../behaviour.ts";

  /**
   * Round avatar of a participant: the picture when there is one, otherwise a bot's generated mascot
   * (shape, colour and eyes from its id) or your initials. `badge` marks a pinned bot (star) or an
   * online one (dot). `appearance` renders an explicitly chosen mascot instead of the legacy hash.
   * Decorative unless `label` is given: the name is usually next to it.
   */
  let {
    participant,
    size = "md",
    badge,
    label,
    appearance,
    alive = true,
    state = "idle",
    event,
    class: className,
  }: { participant: Pick<ParticipantView, "id" | "kind" | "name" | "imageUrl">; size?: AvatarSize; badge?: "pinned" | "online" | undefined; label?: string | undefined; appearance?: BotAppearance; alive?: boolean; state?: MascotState; event?: unknown; class?: ClassValue } = $props();

  const box: Record<AvatarSize, string> = { xs: "size-5", sm: "size-7", md: "size-10", lg: "size-14", xl: "size-18" };
  const initialsText: Record<AvatarSize, string> = { xs: "text-[0.5625rem]", sm: "text-[0.6875rem]", md: "text-sm", lg: "text-lg", xl: "text-xl" };

  const mascot = $derived(mascotFor(participant.id));
  const initials = $derived(
    participant.name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => [...word][0]?.toUpperCase() ?? "")
      .join("") || "?",
  );
</script>

<span class={["relative inline-grid shrink-0", box[size], className]} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
  {#if participant.imageUrl}
    <img src={participant.imageUrl} alt="" class="size-full rounded-full object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10" />
  {:else if participant.kind === "user"}
    <span class={["grid size-full place-items-center rounded-full bg-zinc-200 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200", initialsText[size]]}>{initials}</span>
  {:else if appearance}
    <span class="grid size-full place-items-center rounded-full bg-zinc-950/5 dark:bg-white/10"><MascotFace {...appearance} alive={alive && size !== "xs"} {state} {event} class="size-full" /></span>
  {:else}
    <MascotFace legacy={mascot} alive={alive && size !== "xs"} {state} {event} class={["size-full rounded-full", mascot.tone.background]} />
  {/if}

  {#if badge}<AvatarBadge kind={badge} {size} />{/if}
</span>
