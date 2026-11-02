<script lang="ts">
  import { Provider, ProviderProfileKind, type ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { kindLabel, profileName } from "./profiles.ts";

  /**
   * One provider profile in the worker's list: connection, agents, variables, threads, whether the worker can use
   * it (live from its report), and its actions.
   */
  let {
    profile,
    modelsHref,
    onedit,
    ontoggle,
    ondelete,
    class: className,
  }: {
    profile: ui.ProviderProfileSettings;
    /** Model selection screen of a provider. */
    modelsHref: (provider: Provider) => string;
    onedit: () => void;
    ontoggle: () => void;
    ondelete: () => void;
    class?: ClassValue;
  } = $props();

  const name = $derived(profileName(profile));
  const summary = $derived(
    [
      profile.builtIn ? "Built in: the CLI login on this machine" : kindLabel(profile.kind),
      profile.kind === ProviderProfileKind.CLIPROXYAPI && (URL.canParse(profile.baseUrl) ? new URL(profile.baseUrl).host : profile.baseUrl),
      profile.env.length > 0 && `${profile.env.length} variable${profile.env.length === 1 ? "" : "s"}`,
      profile.threadCount > 0 && `${profile.threadCount} thread${profile.threadCount === 1 ? "" : "s"}`,
    ]
      .filter(Boolean)
      .join(" · "),
  );
  const status = $derived(
    !profile.enabled
      ? { tone: "neutral" as const, text: "Off" }
      : profile.available
        ? { tone: "emerald" as const, text: "Ready" }
        : { tone: "amber" as const, text: profile.detail === "not applied by the worker yet" ? "Pending" : "Unavailable" },
  );
</script>

<SettingsRow title={name} description={summary} class={className}>
  {#snippet leading()}
    <Icon name={profile.kind === ProviderProfileKind.CLIPROXYAPI ? "globe-alt" : "computer-desktop"} class="fill-zinc-400 dark:fill-zinc-500" />
  {/snippet}
  {#snippet control()}
    <span class="flex items-center gap-1 max-sm:hidden" aria-label="Agents: {profile.providers.map(providerLabel).join(', ')}">
      {#each profile.providers as provider (provider)}<ProviderIcon provider={provider === Provider.CLAUDE ? "CLAUDE" : "CODEX"} class="size-4 text-zinc-500 dark:text-zinc-400" />{/each}
    </span>
    <Badge tone={status.tone}>{status.text}</Badge>
    <DropdownMenu label="Actions for {name}" placement="bottom-end">
      {#snippet trigger(props)}<IconButton icon="ellipsis-horizontal" label="Actions for {name}" {...props} />{/snippet}
      <MenuItem icon="pencil-square" onselect={onedit}>Edit…</MenuItem>
      {#each profile.providers as provider (provider)}
        <MenuItem icon="queue-list" href={modelsHref(provider)}>{providerLabel(provider)} models…</MenuItem>
      {/each}
      {#if !profile.builtIn}
        <MenuSeparator />
        <MenuItem icon={profile.enabled ? "pause" : "play"} onselect={ontoggle}>{profile.enabled ? "Turn off" : "Turn on"}</MenuItem>
        <MenuItem icon="trash" danger onselect={ondelete}>Delete…</MenuItem>
      {/if}
    </DropdownMenu>
  {/snippet}
  {#if profile.enabled && !profile.available && profile.detail}
    <p class="mt-1 text-sm/5 text-pretty text-amber-700 dark:text-amber-400">{profile.detail}</p>
  {/if}
</SettingsRow>
