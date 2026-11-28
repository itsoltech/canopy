<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { AgentPreviewInputSchema, type AgentPreviewInput, type ui } from "@canopy/contracts";
  import { loginAllowsOrigin } from "@canopy/domain/project-logins";
  import { listProjectSecrets } from "#lib/features/projects/secrets/api.ts";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";

  /**
   * Enter a project login into the focused field of Browser Preview. The page only gets the field the owner
   * chooses, and only on one of the login's websites; the gateway supplies the value, never this page.
   */
  let {
    projectId,
    url,
    enabled,
    oninput,
  }: { projectId: string; url: string; enabled: boolean; oninput: (input: AgentPreviewInput) => void } = $props();

  let open = $state(false);
  let logins = $state.raw<ui.ProjectSecret[]>();
  let failed = $state(false);
  const origin = $derived(URL.parse(url)?.origin ?? "");

  const matching = $derived(
    (logins ?? []).filter((login) => login.kind === "login" && loginAllowsOrigin(login.login?.websites ?? [], origin)),
  );

  $effect(() => {
    if (!open) return;
    failed = false;
    void listProjectSecrets(projectId).then(
      (loaded) => (logins = loaded),
      () => (failed = true),
    );
  });

  const fill = (name: string, field: string) =>
    oninput(create(AgentPreviewInputSchema, { kind: "login", text: name, key: field }));
</script>

<DropdownMenu label="Fill login" placement="bottom-end" bind:open>
  {#snippet trigger(props)}<IconButton
      size="sm"
      icon="user"
      label="Fill login"
      disabled={!enabled}
      {...props}
    />{/snippet}
  {#if failed}
    <MenuItem disabled description="Close the menu and open it again to retry.">Could not load logins</MenuItem>
  {:else if !logins}
    <MenuItem disabled>Loading logins…</MenuItem>
  {:else if !matching.length}
    <MenuItem
      href={`/settings/projects/${encodeURIComponent(projectId)}#secrets`}
      description="Add one in project settings.">No logins for this website</MenuItem
    >
  {:else}
    {#each matching as login (login.name)}
      <MenuGroup label={login.name}>
        <MenuItem description={login.login?.username} onselect={() => fill(login.name, "username")}
          >Enter username</MenuItem
        >
        <MenuItem onselect={() => fill(login.name, "password")}>Enter password</MenuItem>
        {#if login.login?.oneTimeCode}<MenuItem onselect={() => fill(login.name, "one_time_code")}
            >Enter one-time code</MenuItem
          >{/if}
      </MenuGroup>
    {/each}
  {/if}
</DropdownMenu>
