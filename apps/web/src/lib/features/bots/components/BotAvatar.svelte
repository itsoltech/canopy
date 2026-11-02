<script lang="ts" module>
  export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";
</script>

<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { mascotFor, type BotAppearance } from "../mascot.ts";
  import type { ParticipantView } from "../model.ts";
  import AvatarBadge from "./AvatarBadge.svelte";
  import MascotFace from "./MascotFace.svelte";

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
    class: className,
  }: { participant: Pick<ParticipantView, "id" | "kind" | "name" | "imageUrl">; size?: AvatarSize; badge?: "pinned" | "online" | undefined; label?: string | undefined; appearance?: BotAppearance; class?: ClassValue } = $props();

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
  const eyeX = [16, 24];
</script>

<span class={["relative inline-grid shrink-0", box[size], className]} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : "true"}>
  {#if participant.imageUrl}
    <img src={participant.imageUrl} alt="" class="size-full rounded-full object-cover outline-1 -outline-offset-1 outline-black/5 dark:outline-white/10" />
  {:else if participant.kind === "user"}
    <span class={["grid size-full place-items-center rounded-full bg-zinc-200 font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200", initialsText[size]]}>{initials}</span>
  {:else if appearance}
    <span class="grid size-full place-items-center rounded-full bg-zinc-950/5 dark:bg-white/10"><MascotFace {...appearance} class="size-full" /></span>
  {:else}
    <svg viewBox="0 0 40 40" class={["size-full rounded-full", mascot.tone.background]}>
      <path d={mascot.shape.body} class={mascot.tone.body} />
      {#each eyeX as x (x)}
        {#if mascot.eyes === "round"}
          <circle cx={x} cy={mascot.shape.eyeY} r="3.2" class="fill-white" />
          <circle cx={x + mascot.gaze * 0.9} cy={mascot.shape.eyeY + 0.4} r="1.6" class="fill-zinc-950" />
        {:else if mascot.eyes === "dots"}
          <circle cx={x} cy={mascot.shape.eyeY} r="1.9" class="fill-zinc-950" />
        {:else}
          <path d="M{x - 2.4} {mascot.shape.eyeY + 0.8}q2.4 -3 4.8 0" class="fill-none stroke-zinc-950" stroke-width="1.6" stroke-linecap="round" />
        {/if}
      {/each}
      {#if mascot.smile}
        <path d="M17.5 {mascot.shape.eyeY + 4.5}q2.5 2.2 5 0" class="fill-none stroke-zinc-950" stroke-width="1.4" stroke-linecap="round" />
      {/if}
    </svg>
  {/if}

  {#if badge}<AvatarBadge kind={badge} {size} />{/if}
</span>
