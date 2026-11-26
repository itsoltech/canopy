<script lang="ts">
  import type { EnvironmentSkillStatus } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import ComputerSkillLocation from "./ComputerSkillLocation.svelte";
  import { canImportLocalSkill, groupStatus, needsAttention, type ComputerSkill } from "./computer-skills.ts";

  let {
    group,
    busy,
    waitingTarget,
    onarchive,
    onresolve,
    ondisable,
    onadd,
  }: {
    group: ComputerSkill;
    waitingTarget?: string | undefined;
    busy: boolean;
    onarchive?: ((file: EnvironmentSkillStatus) => void) | undefined;
    onresolve?: ((file: EnvironmentSkillStatus, action: "keep" | "overwrite" | "import") => void) | undefined;
    ondisable?: (() => void) | undefined;
    onadd?: ((file: EnvironmentSkillStatus) => void) | undefined;
  } = $props();

  let open = $state(false);
  const add = $derived(group.missingFromLibrary ? onadd : undefined);
  const first = $derived(group.files[0]!);

  // Keep every actionable copy visible. Collapse only a long tail of healthy installations.
  const visible = $derived(group.files.filter((file, index) => index < 3 || file.status !== "applied"));
  const extra = $derived(group.files.filter((file, index) => index >= 3 && file.status === "applied"));
  const status = $derived(waitingTarget && waitingTarget === first.targetId ? "Archiving copy…" : groupStatus(group));
</script>

<div class="relative min-w-0">
  <Disclosure bind:open align="center" summaryClass="min-h-10 py-1.5 pr-10">
    {#snippet summary()}
      <span class="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
        <span class="font-medium wrap-anywhere">{group.name}</span>
        {#if !open || !needsAttention(first) || !first.path}<span
            class={[
              "text-sm wrap-anywhere",
              needsAttention(first) && waitingTarget !== first.targetId
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted",
            ]}>{status}</span
          >{/if}
      </span>
    {/snippet}
    <div class="grid min-w-0 gap-3 pt-1 pb-4 pl-5">
      {#if group.overlappingAgents.length && (needsAttention(first) || status !== groupStatus(group))}
        <p class="text-sm">{group.overlappingAgents.join(", ")} can find this name in multiple CLI directories.</p>
      {/if}
      {#if group.membership && group.membership !== status}<p class="text-sm text-muted">{group.membership}</p>{/if}
      {#each visible as file (file.targetId)}
        <ComputerSkillLocation
          {file}
          {busy}
          {onresolve}
          {onarchive}
          onadd={add && canImportLocalSkill(file) ? () => add(file) : undefined}
          waiting={waitingTarget === file.targetId}
        />
      {/each}
      {#if extra.length}
        <Disclosure>
          {#snippet summary()}<span class="text-sm text-muted"
              >{extra.length} more {extra.length === 1 ? "location" : "locations"}</span
            >{/snippet}
          <div class="grid min-w-0 gap-3 pt-2">
            {#each extra as file (file.targetId)}<ComputerSkillLocation {file} {busy} />{/each}
          </div>
        </Disclosure>
      {/if}
    </div>
  </Disclosure>
  {#if ondisable}
    <div class="absolute top-0 right-0 flex min-h-10 items-center">
      <DropdownMenu label={`Actions for ${group.name}`} placement="bottom-end">
        {#snippet trigger(props)}<IconButton
            icon="ellipsis-horizontal"
            label={`Actions for ${group.name}`}
            size="sm"
            {...props}
          />{/snippet}
        <MenuItem icon="no-symbol" disabled={busy} onselect={ondisable}>Disable on this computer</MenuItem>
      </DropdownMenu>
    </div>
  {/if}
</div>
