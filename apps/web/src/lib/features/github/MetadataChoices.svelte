<script lang="ts">
  import type { github } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { labelColors } from "@canopy/domain/github-pr";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import SearchField from "#lib/shared/ui/SearchField.svelte";
  import GitHubAvatar from "./GitHubAvatar.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ReRequestReview from "./ReRequestReview.svelte";
  import type { MetadataKind } from "@canopy/domain/github-metadata";

  let {
    options,
    kind,
    snapshot,
    ids,
    disabled,
    ontoggle,
    class: className,
  }: {
    options: github.PullRequestMetadataOption[];
    kind: MetadataKind;
    snapshot: github.PullRequestSnapshot;
    ids: string[];
    disabled: boolean;
    ontoggle: (id: string) => void;
    class?: ClassValue;
  } = $props();

  let query = $state("");
  const shown = $derived(options.filter((o) => o.name.toLowerCase().includes(query.toLowerCase())));
</script>

<div class={["grid min-w-0 gap-2", className]}>
  <SearchField
    name="metadata-search"
    label="Search choices"
    placeholder={kind === "labels"
      ? "Search labels"
      : kind === "reviewers"
        ? "Search people or teams"
        : "Search people"}
    bind:value={query}
  />
  <div class="grid max-h-72 scroll-stable gap-1 overflow-y-auto py-1 pr-2">
    {#each shown as option (option.id)}
      <div class="flex min-h-10 min-w-0 items-center gap-2 rounded px-1 sm:min-h-8">
        {#if option.kind === "label"}
          {@const color = labelColors(option.color)}
          <span
            aria-hidden="true"
            class="size-4 shrink-0 rounded border border-black/15 bg-(--label-bg) dark:border-white/20"
            style:--label-bg={color.background}
          ></span>
        {:else if option.kind === "team"}<Icon name="user-group" label="Team" />{:else}<GitHubAvatar
            userId={option.userId}
            login={option.name}
            compact
          />{/if}
        <div class="min-w-0 flex-1" onchange={() => ontoggle(option.id)}>
          <Checkbox name={`metadata-${option.id}`} label={option.name} checked={ids.includes(option.id)} {disabled} />
        </div>
        {#if kind === "reviewers" && snapshot.reviewers.some((r) => r.nodeId === option.id && r.state !== "requested")}<ReRequestReview
            {snapshot}
            id={option.id}
          />{/if}
      </div>
    {/each}
    {#if !shown.length}<p class="py-2 text-sm text-zinc-500 dark:text-zinc-400">No matching choices</p>{/if}
  </div>
</div>
