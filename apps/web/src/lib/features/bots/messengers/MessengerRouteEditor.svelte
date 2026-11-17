<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { untrack } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { saveMessengerRoute, slackIds, saveOnEnter } from "./api.ts";

  let {
    botId,
    route,
    accounts,
    onsaved,
    oncancel,
  }: {
    botId: string;
    route?: ui.BotMessengerRoute;
    accounts: ui.MessengerAccount[];
    onsaved: () => void;
    oncancel: () => void;
  } = $props();

  let accountId = $state(untrack(() => route?.accountId ?? accounts[0]?.id ?? ""));
  let channels = $state(untrack(() => route?.channelIds.join(", ") ?? ""));
  let users = $state(untrack(() => route?.userIds.join(", ") ?? ""));
  let directMessages = $state(untrack(() => route?.directMessages ?? true));
  let mentions = $state(untrack(() => route?.mentions ?? true));
  let observe = $state(untrack(() => route?.observe ?? false));
  let delivery = $state(untrack(() => route?.delivery ?? "reply"));
  let instructions = $state(untrack(() => route?.instructions ?? ""));
  let busy = $state(false);
  let error = $state("");
  const options = $derived(accounts.map((account) => ({ value: account.id, label: account.name })));

  async function save() {
    if (busy) return;
    error = "";

    try {
      const channelIds = slackIds(channels, "channel");
      const userIds = slackIds(users, "user");

      if (!accountId) throw new Error("Choose a Slack account before saving.");

      if ((mentions || observe) && !channelIds.length)
        throw new Error("Add Slack channel IDs for mentions or channel monitoring.");

      if (!directMessages && !mentions && !observe) throw new Error("Choose at least one kind of message to receive.");
      busy = true;
      await saveMessengerRoute(botId, {
        id: route?.id,
        botId,
        accountId,
        channelIds,
        userIds,
        directMessages,
        mentions,
        observe,
        delivery,
        instructions,
      });
      onsaved();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not save the route. Check its settings and try again.";
    } finally {
      busy = false;
    }
  }
</script>

<div class="grid min-w-0 gap-3 rounded-xl border border-zinc-950/10 p-4 dark:border-white/10" aria-busy={busy}>
  <h4 class="font-medium">{route ? "Edit message route" : "Add message route"}</h4>
  <Field label="Slack account"
    ><Select class="min-w-0" bind:value={accountId} {options} disabled={busy || !!route} /></Field
  >
  <Field
    label="Allowed user IDs"
    description="Separate IDs with commas to allow only these Slack users to trigger the bot."
  >
    <Input
      onkeydown={(event) => saveOnEnter(event, save)}
      bind:value={users}
      placeholder="U0123456789, U9876543210"
      disabled={busy}
      spellcheck={false}
    />
  </Field>
  <Field
    label="Channel IDs"
    optional={!mentions && !observe}
    description="Invite the app to each channel and separate its channel IDs with commas."
  >
    <Input
      onkeydown={(event) => saveOnEnter(event, save)}
      bind:value={channels}
      placeholder="C0123456789, G9876543210"
      disabled={busy}
      spellcheck={false}
    />
  </Field>
  <Checkbox name="messenger-direct" label="Receive direct messages" bind:checked={directMessages} disabled={busy} />
  <Checkbox
    name="messenger-mentions"
    label="Receive mentions in selected channels"
    bind:checked={mentions}
    disabled={busy}
  />
  <Checkbox
    name="messenger-observe"
    label="Monitor selected channels"
    description="Messages from allowed users start bot turns without mentions and use model tokens."
    bind:checked={observe}
    disabled={busy}
  />
  <Field label="Deliver responses">
    <Select
      class="min-w-0"
      bind:value={delivery}
      disabled={busy}
      options={[
        { value: "reply", label: "Reply in Slack" },
        { value: "notify", label: "Notify me in Canopy" },
      ]}
    />
  </Field>
  <Field
    label="Route instructions"
    optional
    description="Describe how this bot should handle messages from these channels and people."
  >
    <Textarea
      bind:value={instructions}
      rows={3}
      maxlength={10000}
      disabled={busy}
      placeholder="Summarize release blockers in Notion and start a thread for issues that need investigation."
    />
  </Field>
  <p class="text-sm text-zinc-500 dark:text-zinc-400">
    This bot can use its connected tools. Each conversation has separate history. Your account settings stay private.
  </p>
  {#if error}<Alert tone="error">{error}</Alert>{/if}
  <div class="flex flex-wrap justify-end gap-2">
    <Button disabled={busy} onclick={oncancel}>Cancel</Button>
    <Button variant="primary" loading={busy} onclick={save}>Save route</Button>
  </div>
</div>
