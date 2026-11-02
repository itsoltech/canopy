<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { ui } from "@open-agents/contracts";
  import { untrack } from "svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { createSchedule } from "./api.ts";
  import { describeCron } from "./schedules.ts";
  import NewThreadScheduleFields from "./NewThreadScheduleFields.svelte";
  import GrowIn from "#lib/shared/ui/GrowIn.svelte";

  /**
   * New scheduled task: what to tell the agent, once at a time or repeatedly (a preset or a cron) in a
   * time zone, until a date or for a number of runs. With `threadId` it is for that thread; otherwise
   * you pick one of `threads`.
   */
  let {
    open = $bindable(false),
    threadId: fixedThreadId,
    threads = [],
    oncreated,
  }: {
    open?: boolean;
    threadId?: string | undefined;
    threads?: readonly ui.Thread[];
    oncreated?: ((schedule: ui.Schedule) => void) | undefined;
  } = $props();

  const overview = useOverview();
  const groups = $derived(
    overview.projects
      .map((project) => ({ project, threads: threads.filter((t) => t.projectId === project.id && t.status !== "archived") }))
      .filter((g) => g.threads.length > 0),
  );

  // datetime-local wants local "YYYY-MM-DDTHH:MM".
  const local = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const nextHour = () => {
    const date = new Date(Date.now() + 3_600_000);
    date.setMinutes(0, 0, 0);
    return date;
  };
  const ownZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const zones = (() => {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes(ownZone) ? all : [ownZone, ...all];
  })();
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let threadId = $state("");
  let target = $state<"thread" | "new_thread">("thread");
  let newThread = $state<ui.NewThreadSchedule>();
  let concurrency = $state("skip_if_running");
  let name = $state("");
  let prompt = $state("");
  let kind = $state<"once" | "recurring">("once");
  let runAt = $state("");
  let frequency = $state<"hourly" | "daily" | "weekdays" | "weekly" | "custom">("daily");
  let time = $state("09:00");
  let minute = $state(0);
  let weekday = $state("1");
  let customCron = $state("");
  let timezone = $state(ownZone);
  let ends = $state<"never" | "until" | "count">("never");
  let until = $state("");
  let maxRuns = $state(5);
  let missedPolicy = $state<"run_once" | "skip">("run_once");
  let busy = $state(false);
  let error = $state<string>();

  // Every opening starts from a fresh form.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      threadId = fixedThreadId ?? groups[0]?.threads[0]?.id ?? "";
      target = fixedThreadId || groups.length ? "thread" : "new_thread";
      newThread = undefined;
      concurrency = "skip_if_running";
      name = "";
      missedPolicy = "run_once";
      prompt = "";
      kind = "once";
      runAt = local(nextHour());
      frequency = "daily";
      ends = "never";
      until = local(new Date(Date.now() + 7 * 86_400_000));
      error = undefined;
    });
  });

  const cron = $derived.by(() => {
    const [hours = "9", minutes = "0"] = time.split(":").map((part) => String(Number(part)));
    switch (frequency) {
      case "hourly":
        return `${Math.min(59, Math.max(0, Math.trunc(minute) || 0))} * * * *`;
      case "daily":
        return `${minutes} ${hours} * * *`;
      case "weekdays":
        return `${minutes} ${hours} * * 1-5`;
      case "weekly":
        return `${minutes} ${hours} * * ${weekday}`;
      default:
        return customCron.trim().replace(/\s+/g, " ");
    }
  });

  function request(): ui.CreateScheduleRequest | string {
    if (target === "thread" && !threadId) return "Choose a thread.";
    if (target === "new_thread" && (!newThread?.projectId || !newThread.provider)) return "Choose a project and an agent.";
    const destination = { target, threadId: target === "thread" ? threadId : "", ...(target === "new_thread" && newThread && { newThread }), concurrency, name };
    if (!prompt.trim()) return "Tell the agent what to do.";
    if (kind === "once") {
      const date = new Date(runAt);
      if (Number.isNaN(date.getTime())) return "Choose when to run it.";
      if (date.getTime() < Date.now()) return "Choose a time in the future.";
      return create(ui.CreateScheduleRequestSchema, { ...destination, prompt: prompt.trim(), when: { case: "runAt", value: timestampFromDate(date) }, missedPolicy });
    }
    if (cron.split(" ").length !== 5) return "A cron has five fields: minute, hour, day of month, month, day of week.";
    const end = ends === "until" ? new Date(until) : undefined;
    if (end && (Number.isNaN(end.getTime()) || end.getTime() < Date.now())) return "The end date must be in the future.";
    if (ends === "count" && !(maxRuns >= 1)) return "Run it at least once.";
    return create(ui.CreateScheduleRequestSchema, {
      ...destination,
      prompt: prompt.trim(),
      when: { case: "cron", value: cron },
      timezone,
      ...(end && { until: timestampFromDate(end) }),
      ...(ends === "count" && { maxRuns: Math.trunc(maxRuns) }),
      missedPolicy,
    });
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const built = request();
    if (typeof built === "string") {
      error = built;
      return;
    }
    busy = true;
    error = undefined;
    try {
      const schedule = await createSchedule(built);
      if (schedule) oncreated?.(schedule);
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not create the schedule";
    } finally {
      busy = false;
    }
  }

  const segment =
    "flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-base/6 font-medium text-zinc-600 has-checked:bg-white has-checked:text-zinc-950 has-checked:shadow-xs has-checked:ring-1 has-checked:ring-zinc-950/10 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:has-checked:bg-white/10 dark:has-checked:text-white dark:has-checked:shadow-none dark:has-checked:ring-white/10";
</script>

<Dialog bind:open title="Schedule a task" description="Send a message at a set time, in an existing thread or a fresh thread for each run." size="lg">
  <form class="grid gap-5" onsubmit={submit} novalidate>
    <Field label="Run the task">
      <Select name="target" bind:value={target}>
        <option value="thread">In this thread</option>
        <option value="new_thread">Start a new thread each run</option>
      </Select>
    </Field>
    {#if target === "new_thread"}
      <GrowIn><NewThreadScheduleFields bind:value={newThread} /></GrowIn>
    {:else if !fixedThreadId}
      <Field label="Thread">
        <Select name="threadId" bind:value={threadId}>
          {#each groups as group (group.project.id)}
            <optgroup label={group.project.name}>
              {#each group.threads as thread (thread.id)}<option value={thread.id}>{thread.title}</option>{/each}
            </optgroup>
          {:else}
            <option value="">No threads yet</option>
          {/each}
        </Select>
      </Field>
    {/if}

    <Field label="Message to the agent">
      <Textarea name="prompt" rows={3} bind:value={prompt} placeholder="Check the build and report anything that broke." data-autofocus required />
    </Field>
    <Field label="Task name (optional)">
      <Input name="scheduleName" bind:value={name} maxlength={120} placeholder="Use the message as its name" />
    </Field>

    <fieldset class="grid gap-3">
      <legend class="sr-only">When</legend>
      <div class="flex gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5">
        <label class={segment}><input type="radio" name="kind" value="once" class="sr-only" bind:group={kind} />Once</label>
        <label class={segment}><input type="radio" name="kind" value="recurring" class="sr-only" bind:group={kind} />Repeat</label>
      </div>

      {#if kind === "once"}
        <Field label="Run at" description="In your time zone ({ownZone}).">
          <Input type="datetime-local" name="runAt" bind:value={runAt} min={local(new Date())} required />
        </Field>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label="How often">
            <Select name="frequency" bind:value={frequency}>
              <option value="hourly">Every hour</option>
              <option value="daily">Every day</option>
              <option value="weekdays">Weekdays</option>
              <option value="weekly">Every week</option>
              <option value="custom">Custom (cron)</option>
            </Select>
          </Field>
          {#if frequency === "hourly"}
            <Field label="At minute">
              <Input type="number" name="minute" min="0" max="59" bind:value={minute} />
            </Field>
          {:else if frequency === "custom"}
            <Field label="Cron">
              <Input name="cron" bind:value={customCron} placeholder="*/30 9-17 * * 1-5" autocomplete="off" spellcheck="false" class="font-mono" />
            </Field>
          {:else}
            <Field label="At">
              <Input type="time" name="time" bind:value={time} required />
            </Field>
          {/if}
          {#if frequency === "weekly"}
            <Field label="On">
              <Select name="weekday" bind:value={weekday}>
                {#each weekdays as day, index (day)}<option value={String(index)}>{day}</option>{/each}
              </Select>
            </Field>
          {/if}
          <Field label="Time zone" class={frequency === "weekly" ? "" : "sm:col-span-2"}>
            <Select name="timezone" bind:value={timezone}>
              {#each zones as zone (zone)}<option value={zone}>{zone}</option>{/each}
            </Select>
          </Field>
          <Field label="Ends">
            <Select name="ends" bind:value={ends}>
              <option value="never">Never</option>
              <option value="until">On a date</option>
              <option value="count">After a number of runs</option>
            </Select>
          </Field>
          {#if ends === "until"}
            <Field label="Last run before">
              <Input type="datetime-local" name="until" bind:value={until} min={local(new Date())} />
            </Field>
          {:else if ends === "count"}
            <Field label="Runs">
              <Input type="number" name="maxRuns" min="1" bind:value={maxRuns} />
            </Field>
          {/if}
        </div>
        {#if cron}
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            {describeCron(cron)}{describeCron(cron) === cron ? "" : ` · ${cron}`} in {timezone}. Runs at least 5 minutes apart.
          </p>
        {/if}
      {/if}
    </fieldset>

    {#if target === "new_thread" && kind === "recurring"}
      <Field label="While a previous run is working">
        <Select name="concurrency" bind:value={concurrency}>
          <option value="skip_if_running">Skip the next run</option>
          <option value="allow">Start another thread</option>
        </Select>
      </Field>
    {/if}
    <Field label="If a run is missed" description="After a gateway outage, or after 2 minutes without an eligible worker for a pool.">
      <Select name="missedPolicy" bind:value={missedPolicy}>
        <option value="run_once">Run once when back</option>
        <option value="skip">Skip it</option>
      </Select>
    </Field>

    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <div class="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" icon="clock" loading={busy}>Schedule</Button>
    </div>
  </form>
</Dialog>
