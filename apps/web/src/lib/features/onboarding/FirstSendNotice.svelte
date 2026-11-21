<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
</script>

<div class="flex items-start gap-2 rounded-lg bg-panel px-3 py-2 text-sm/5 text-zinc-600 dark:text-zinc-300">
  <Icon name="shield-check" class="mt-0.5" />
  <p>
    The agent can send messages, file contents and tool results to the configured model service.
    <TextLink href="/setup/privacy">Learn about privacy</TextLink>
  </p>
</div>
