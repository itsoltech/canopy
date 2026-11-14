<script lang="ts">
  import { untrack } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { accessSummary, sameAccess, type AccessChoice } from "@canopy/domain/access-picker";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import PickerTrigger from "#lib/shared/ui/PickerTrigger.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import AccessList from "./AccessList.svelte";
  import type { AccessOption } from "./access-options.ts";

  /**
   * Who may use something, as one compact row: the label on the left, a summary ("All workers",
   * "3 of 12 workers") on the right that opens a searchable checklist (a bottom sheet on phones). The choice is
   * edited in the popover and `onchange` gets it once, when the popover closes; the caller saves it.
   */
  let {
    label,
    description,
    noun = label.toLowerCase(),
    icon,
    options,
    all = false,
    ids,
    allowAll = true,
    saving = false,
    disabled = false,
    error,
    onchange,
    class: className,
  }: {
    label: string;
    description?: string | undefined;
    /** Plural, lower case; defaults to the label. */
    noun?: string;
    icon: IconName;
    options: readonly AccessOption[];
    all?: boolean;
    ids: readonly string[];
    /** Offer "All …" (also ones added later). */
    allowAll?: boolean;
    saving?: boolean;
    disabled?: boolean;
    error?: string | undefined;
    onchange: (next: AccessChoice) => void;
    class?: ClassValue;
  } = $props();

  const id = $props.id();
  let open = $state(false);
  let draft = $state<AccessChoice>({ all: false, ids: [] });
  const current = $derived<AccessChoice>({ all: allowAll && all, ids });
  const summary = $derived(accessSummary(open ? draft : current, options, noun));

  let wasOpen = false;

  // The popover edits a copy taken when it opens; closing commits it (`onclose` runs after the exit motion).
  $effect.pre(() => {
    if (open && !wasOpen) draft = untrack(() => ({ all: current.all, ids: [...current.ids] }));
    wasOpen = open;
  });

  function commit() {
    if (!sameAccess(draft, current)) onchange({ all: draft.all, ids: [...draft.ids] });
  }
</script>

<div class={["grid min-w-0 gap-1.5", className]}>
  <div class="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-4">
    <div class="min-w-0 flex-1">
      <p id="{id}-label" class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{label}</p>
      {#if description}<p class="text-sm/5 text-pretty text-zinc-500 dark:text-zinc-400">{description}</p>{/if}
    </div>
    <!-- Kit triggers own their padding; the wrapper sizes it (docs: Tailwind v4 pitfall). -->
    <div class="w-full shrink-0 sm:w-64">
      <Popover bind:open {label} sheet placement="bottom-end" class="w-[min(22rem,calc(100vw-1rem))]" onclose={commit}>
        {#snippet trigger(props)}
          <PickerTrigger
            {...props}
            text={saving ? "Saving…" : summary}
            icon="chevron-up-down"
            leadingIcon={icon}
            disabled={disabled || saving}
            aria-labelledby="{id}-label {id}-value"
            class="w-full"
          />
        {/snippet}
        <AccessList bind:choice={draft} {options} {noun} {icon} {allowAll} />
      </Popover>
      <span id="{id}-value" class="sr-only">{summary}</span>
    </div>
  </div>
  <FieldError message={error} />
</div>
