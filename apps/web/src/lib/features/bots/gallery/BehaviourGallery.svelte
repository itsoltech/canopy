<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import type { MascotState } from "../behaviour.ts";
  import { mascotShapes } from "../mascot.ts";
  import AnimatedMascotsSetting from "../components/AnimatedMascotsSetting.svelte";
  import BotAvatar from "../components/BotAvatar.svelte";
  import MascotFace from "../components/MascotFace.svelte";
  import GallerySection from "./GallerySection.svelte";

  let { class: className }: { class?: ClassValue } = $props();
  let expression = $state<MascotState>("idle");
  let message = $state(0);
  const states: MascotState[] = ["idle", "working", "typing", "waiting", "done", "error"];

  const specimens = Array.from({ length: 50 }, (_, i) => ({
    id: `living-${i}`,
    kind: "bot" as const,
    name: `Mascot ${i + 1}`,
  }));
</script>

<GallerySection
  title="Living mascots"
  description="Move the pointer, pause, or tap on a touch screen. Fifty independent characters share one pointer listener and one frame scheduler. Small avatars and reduced motion stay still."
  class={className}
>
  <div data-mascot-lab class="grid gap-4">
    <div class="flex flex-wrap items-center gap-3">
      <Select
        name="mascot-state"
        aria-label="Mascot expression"
        value={expression}
        options={states.map((value) => ({ value, label: value }))}
        onchange={(value) => (expression = value as MascotState)}
        class="w-36"
      />
      <Button onclick={() => message++}>Send / receive message</Button>
      <MascotFace shape="round" label="Tiny static mascot" class="size-4" />
      <BotAvatar participant={specimens[0]!} size="xs" label="Small static avatar" />
      <MascotFace alive={false} label="Disabled mascot" class="size-10" />
    </div>
    <div data-mascot-grid class="grid max-w-2xl grid-cols-5 justify-items-start gap-3 sm:grid-cols-10">
      {#each specimens as bot, i (bot.id)}
        <BotAvatar
          participant={bot}
          size="md"
          label={bot.name}
          state={expression}
          event={message}
          appearance={i < 14 ? { shape: mascotShapes[i]!.id, color: i % 2 ? "#8b5cf6" : "#f97316" } : undefined}
        />
      {/each}
    </div>
    <AnimatedMascotsSetting class="rounded-xl bg-zinc-950/3 dark:bg-white/4" />
  </div>
</GallerySection>
