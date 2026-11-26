<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import { fullDateLabel } from "../chat-timeline.ts";
  import type { ChatEventView } from "@canopy/domain/bot-chat";
  import { decodeThemeBuilderPatch } from "@canopy/ui/theme-builder";
  import Button from "#lib/shared/ui/Button.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import BotSettingChangesDialog from "../settings/BotSettingChangesDialog.svelte";

  /** Something that happened rather than something said, centered: "Deleted routine · Canopy: scalenie PR #443 po CI". */
  let { event, class: className }: { event: ChatEventView; class?: ClassValue } = $props();
  let viewing = $state(false);

  const themeHref = $derived(
    event.themeBuilderPatch && decodeThemeBuilderPatch(event.themeBuilderPatch)
      ? `/settings/appearance?${new URLSearchParams({ theme: event.themeBuilderPatch })}#topic-theme-builder`
      : undefined,
  );

  const icons: Record<ChatEventView["kind"], IconName> = {
    routine_created: "arrow-path-rounded-square",
    routine_deleted: "trash",
    routines_disabled: "no-symbol",
    relayed_message: "chat-bubble-left",
    joined: "user-group",
    info: "information-circle",
  };
</script>

<div
  class={[
    "flex flex-wrap items-center justify-center gap-1.5 px-3 text-center text-sm/5 text-zinc-500 dark:text-zinc-400",
    className,
  ]}
  title={fullDateLabel(event.at)}
>
  {#if themeHref}
    <ButtonLink href={themeHref} size="sm">Review theme</ButtonLink>
  {:else}
    <span class="min-w-0 text-pretty wrap-anywhere">
      <Icon name={icons[event.kind]} class="inline-block fill-zinc-400 align-text-bottom dark:fill-zinc-500" />
      {event.text}{#if event.detail}<span class="text-zinc-400 dark:text-zinc-600">{" · "}</span><span
          class="text-zinc-700 dark:text-zinc-300">{event.detail}</span
        >{/if}
    </span>
  {/if}
  {#if event.changes?.length}<Button size="sm" variant="ghost" onclick={() => (viewing = true)}>View</Button>{/if}
</div>
{#if event.changes?.length}
  <BotSettingChangesDialog bind:open={viewing} {event} />
{/if}
