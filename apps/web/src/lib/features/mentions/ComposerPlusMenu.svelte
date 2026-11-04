<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import type { TriggerChar } from "./editor.ts";
  import { kindLook } from "./kinds.ts";
  import { MentionKind } from "@canopy/contracts";

  /**
   * The composer's "+": attach files (the system picker; on phones also the camera and photos) and, for
   * discoverability, each mention trigger: choosing one types it at the caret and opens its list. The hint on the
   * right is the character that does the same while typing.
   */
  let {
    onfiles,
    ontrigger,
    triggers,
    disabled = false,
  }: {
    onfiles?: ((files: File[]) => void) | undefined;
    ontrigger?: ((char: TriggerChar) => void) | undefined;
    triggers: ReadonlySet<TriggerChar>;
    disabled?: boolean;
  } = $props();

  let input = $state<HTMLInputElement>();

  const entries: { char: TriggerChar; label: string; description: string; kind: MentionKind }[] = [
    { char: "/", label: "Command", description: "Run a command of the agent", kind: MentionKind.COMMAND },
    {
      char: "$",
      label: "Skill or plugin",
      description: "Point the agent to a skill or a plugin",
      kind: MentionKind.SKILL,
    },
    { char: "@", label: "File", description: "A file or folder of the thread's workspace", kind: MentionKind.FILE },
    { char: "#", label: "Thread", description: "Another thread the agent can read", kind: MentionKind.THREAD },
  ];

  const offered = $derived(ontrigger ? entries.filter((e) => triggers.has(e.char)) : []);
</script>

<DropdownMenu label="Add to the message" placement="top-start">
  {#snippet trigger(props)}<IconButton
      icon="plus"
      label="Add files, commands, skills…"
      size="sm"
      {disabled}
      {...props}
    />{/snippet}
  {#if onfiles}
    <MenuItem icon="paper-clip" onselect={() => input?.click()}>Attach files</MenuItem>
  {/if}
  {#if onfiles && offered.length > 0}<MenuSeparator />{/if}
  {#each offered as entry (entry.char)}
    <MenuItem
      icon={kindLook({ kind: entry.kind, isDir: false }).icon}
      shortcut={entry.char}
      description={entry.description}
      onselect={() => ontrigger?.(entry.char)}
    >
      {entry.label}
    </MenuItem>
  {/each}
</DropdownMenu>
{#if onfiles}
  <input
    bind:this={input}
    type="file"
    multiple
    class="sr-only"
    tabindex="-1"
    aria-hidden="true"
    onchange={(event) => {
      const target = event.currentTarget;
      onfiles?.([...(target.files ?? [])]);
      target.value = "";
    }}
  />
{/if}
