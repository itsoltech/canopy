<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";

  let {
    url,
    number,
    busy,
    oncopy,
    onrefresh,
    onunlink,
    oncontext,
  }: {
    url: string;
    number: number;
    busy: boolean;
    oncopy: (value: string, message: string) => Promise<void>;
    onrefresh: () => void;
    onunlink?: (() => void) | undefined;
    oncontext?: ((action: string) => void) | undefined;
  } = $props();
</script>

<DropdownMenu label="Pull request actions" placement="bottom-end" sheet>
  {#snippet trigger(props)}<IconButton
      icon="ellipsis-horizontal"
      label="Pull request actions"
      size="sm"
      {...props}
    />{/snippet}
  <MenuItem icon="arrow-path" disabled={busy} onselect={() => onrefresh()}>Refresh pull request</MenuItem>
  {#if oncontext}
    <MenuItem icon="chat-bubble-left" disabled={busy} onselect={() => oncontext?.("question")}>Ask a question</MenuItem>
    <MenuItem icon="document-text" disabled={busy} onselect={() => oncontext?.("explain")}>Explain this PR</MenuItem>
    <MenuItem icon="wrench" disabled={busy} onselect={() => oncontext?.("findings")}
      >Fix findings in this thread</MenuItem
    >
  {/if}
  <MenuItem icon="arrow-top-right-on-square" onselect={() => window.open(url, "_blank", "noopener,noreferrer")}
    >Open on GitHub</MenuItem
  >
  <MenuItem icon="link" onselect={() => void oncopy(url, "PR link copied")}>Copy link</MenuItem>
  <MenuItem icon="copy" onselect={() => void oncopy(String(number), "PR number copied")}>Copy PR number</MenuItem>
  {#if onunlink}<MenuSeparator /><MenuItem icon="x-mark" onselect={onunlink}>Unlink</MenuItem>{/if}
</DropdownMenu>
