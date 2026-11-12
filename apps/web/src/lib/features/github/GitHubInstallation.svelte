<script lang="ts">
  import type { github } from "@canopy/contracts";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import GitHubRepositories from "./GitHubRepositories.svelte";

  let {
    accountId,
    installation,
    installUrl,
    class: className,
  }: { accountId: string; installation: github.GitHubInstallation; installUrl: string; class?: string } = $props();

  let open = $state(false);

  const openGitHub = (url: string) => {
    window.open(url, "_blank", "noopener,noreferrer");
  };
</script>

<div class={["relative min-w-0", className]}>
  <Disclosure
    bind:open
    align="center"
    summaryClass="min-h-11 py-2 pr-12 pl-2 hover:bg-zinc-950/3 focus-visible:bg-zinc-950/3 dark:hover:bg-white/5 dark:focus-visible:bg-white/5"
  >
    {#snippet summary()}<div class="flex min-w-0 items-center gap-2 text-base/5 sm:text-sm/5">
        <TruncatedText text={installation.login} />{#if installation.suspended}<span
            class="shrink-0 text-sm text-zinc-500 dark:text-zinc-400">Suspended</span
          >{/if}
      </div>{/snippet}
    <div class="min-w-0 pt-2 pr-2 pb-3 pl-8">
      {#if installation.suspended}<p class="py-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
          This installation is suspended. Ask its administrator to restore access.
        </p>
      {:else}<GitHubRepositories {accountId} installationId={installation.installationId} />{/if}
    </div>
  </Disclosure>
  <div class="absolute top-1.5 right-2">
    <DropdownMenu label={`Actions for ${installation.login}`} placement="bottom-end" sheet>
      {#snippet trigger(props)}<IconButton
          icon="ellipsis-horizontal"
          label={`Actions for ${installation.login}`}
          size="sm"
          {...props}
        />{/snippet}
      <MenuItem onselect={() => openGitHub(installation.manageUrl)}>Manage repositories</MenuItem>
      {#if installUrl}<MenuItem onselect={() => openGitHub(installUrl)}>Install on another account</MenuItem>{/if}
    </DropdownMenu>
  </div>
</div>
