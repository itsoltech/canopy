<script lang="ts">
  import { create, isMessage } from "@bufbuild/protobuf";
  import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
  import { ui } from "@canopy/contracts";
  import timeZones from "@canopy/ui/timezones";
  import { untrack } from "svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import Field from "#lib/shared/ui/Field.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import Textarea from "#lib/shared/ui/Textarea.svelte";
  import { createSchedule, updateSchedule } from "./api.ts";
  import { describeCron } from "./schedules.ts";
  import NewThreadScheduleFields from "./NewThreadScheduleFields.svelte";
  import SchedulePreview from "./SchedulePreview.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import type { ClassValue } from "svelte/elements";
  import { computerName } from "@canopy/domain/computer-presence";
  import { awayReason } from "#lib/features/computers/computers.ts";

  /**
   * New scheduled task: what to tell the agent, once at a time or repeatedly (a preset or a cron) in a
   * time zone, until a date or for a number of runs. With `threadId` it is for that thread; otherwise
   * you pick one of `threads`.
   */
  let {
    open = $bindable(false),
    threadId: fixedThreadId,
    threads = [],
    schedule: editing,
    oncreated,
    class: className,
  }: {
    open?: boolean;
    threadId?: string | undefined;
    threads?: readonly ui.Thread[];
    schedule?: ui.Schedule | undefined;
    oncreated?: ((schedule: ui.Schedule) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();

  const groups = $derived(
    overview.projects
      .map((project) => ({
        project,
        threads: threads.filter((t) => t.projectId === project.id && t.status !== "archived"),
      }))
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

  const zones = $derived.by(() => {
    return [...new Set([ownZone, timezone, ...timeZones])];
  });

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
  let expectedVersion = $state(0);

  // Every opening starts from a fresh form.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      expectedVersion = editing?.version ?? 0;
      threadId = editing?.threadId || fixedThreadId || groups[0]?.threads[0]?.id || "";
      target = editing
        ? editing.target === "new_thread"
          ? "new_thread"
          : "thread"
        : fixedThreadId || groups.length
          ? "thread"
          : "new_thread";
      newThread = editing?.newThread ? create(ui.NewThreadScheduleSchema, editing.newThread) : undefined;
      concurrency = editing?.concurrency || "skip_if_running";
      name = editing?.configuredName ?? "";
      missedPolicy = editing?.missedPolicy === "skip" ? "skip" : "run_once";
      prompt = editing?.prompt ?? "";
      kind = editing?.kind === "recurring" ? "recurring" : "once";
      runAt = local(editing?.runAt ? timestampDate(editing.runAt) : nextHour());
      frequency = editing?.kind === "recurring" ? "custom" : "daily";
      customCron = editing?.cron ?? "";
      timezone = editing?.timezone || ownZone;
      time = "09:00";
      minute = 0;
      weekday = "1";
      ends = editing?.until ? "until" : editing?.maxRuns ? "count" : "never";
      until = local(editing?.until ? timestampDate(editing.until) : new Date(Date.now() + 7 * 86_400_000));
      maxRuns = editing?.maxRuns || 5;
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

    if (target === "new_thread" && (!newThread?.projectId || !newThread.provider))
      return "Choose a project and an agent.";

    const destination = {
      target,
      threadId: target === "thread" ? threadId : "",
      ...(target === "new_thread" && newThread && { newThread }),
      concurrency,
      name,
    };

    if (!prompt.trim()) return "Tell the agent what to do.";

    if (kind === "once") {
      const date =
        editing?.runAt && runAt === local(timestampDate(editing.runAt))
          ? timestampDate(editing.runAt)
          : new Date(runAt);

      if (Number.isNaN(date.getTime())) return "Choose when to run it.";

      if (date.getTime() < Date.now() - 60_000) return "Choose a time in the future.";

      return create(ui.CreateScheduleRequestSchema, {
        ...destination,
        prompt: prompt.trim(),
        when: { case: "runAt", value: timestampFromDate(date) },
        missedPolicy,
      });
    }

    if (cron.split(" ").length !== 5) return "A cron has five fields: minute, hour, day of month, month, day of week.";

    const end =
      ends === "until"
        ? editing?.until && until === local(timestampDate(editing.until))
          ? timestampDate(editing.until)
          : new Date(until)
        : undefined;

    if (end && (Number.isNaN(end.getTime()) || end.getTime() < Date.now()))
      return "The end date must be in the future.";

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

    if (!isMessage(built, ui.CreateScheduleRequestSchema)) {
      error = built;

      return;
    }

    busy = true;
    error = undefined;

    try {
      const schedule = editing
        ? await updateSchedule(
            create(ui.UpdateScheduleRequestSchema, { scheduleId: editing.id, expectedVersion, configuration: built }),
          )
        : await createSchedule(built);

      if (schedule) oncreated?.(schedule);
      open = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not save the schedule";
    } finally {
      busy = false;
    }
  }

  const segment =
    "flex flex-1 cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-base/6 font-medium text-zinc-600 has-checked:bg-white has-checked:text-zinc-950 has-checked:shadow-xs has-checked:ring-1 has-checked:ring-zinc-950/10 has-focus-visible:outline-2 has-focus-visible:outline-brand-500 pointer-coarse:min-h-12 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:has-checked:bg-white/10 dark:has-checked:text-white dark:has-checked:shadow-none dark:has-checked:ring-white/10";
</script>

<Dialog
  bind:open
  title={editing ? "Edit scheduled task" : "Schedule a task"}
  description={editing
    ? "Changes apply to work that has not started. Editing keeps this task’s status and run history."
    : "Send a message at a set time, in an existing thread or a fresh thread for each run."}
  size="lg"
  class={className}
>
  <form class="grid gap-5" onsubmit={submit} novalidate>
    <Field label="Run the task">
      <Select
        name="target"
        bind:value={target}
        options={[
          { value: "thread", label: "In this thread" },
          { value: "new_thread", label: "Start a new thread each run" },
        ]}
      />
    </Field>
    {#if target === "new_thread"}
      {#key editing?.id}<NewThreadScheduleFields bind:value={newThread} homeId={editing?.id} />{/key}
    {:else if editing?.target === "thread"}
      <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        In {overview.threads.get(editing.threadId)?.title || "the original thread"}. To use another existing thread,
        create a separate task.
      </p>
    {:else if !fixedThreadId}
      <Field label="Thread" class="min-w-0">
        <Select
          name="threadId"
          bind:value={threadId}
          options={groups.length
            ? groups.flatMap((group) =>
                group.threads.map((thread) => ({
                  value: thread.id,
                  label: thread.title,
                  disabled: Boolean(thread.nodeId && awayReason(overview.computer(thread.nodeId))),
                  description: thread.nodeId ? awayReason(overview.computer(thread.nodeId)) : undefined,
                  group: `${group.project.name} · ${group.project.nodeId ? computerName(overview.computer(group.project.nodeId)) : "This computer"}`,
                })),
              )
            : [{ value: "", label: "No threads yet" }]}
        />
      </Field>
    {/if}

    <Field label="Message to the agent">
      <Textarea
        name="prompt"
        rows={3}
        bind:value={prompt}
        placeholder="Check the build and report anything that broke."
        data-autofocus
        required
      />
    </Field>
    <Field label="Task name (optional)">
      <Input name="scheduleName" bind:value={name} maxlength={120} placeholder="Use the message as its name" />
    </Field>

    <fieldset class="grid gap-3">
      <legend class="sr-only">When</legend>
      <div class="flex gap-0.5 rounded-lg bg-zinc-950/5 p-0.5 dark:bg-white/5">
        <label class={segment}
          ><input type="radio" name="kind" value="once" class="sr-only" bind:group={kind} />Once</label
        >
        <label class={segment}
          ><input type="radio" name="kind" value="recurring" class="sr-only" bind:group={kind} />Repeat</label
        >
      </div>

      {#if kind === "once"}
        <Field label="Run at" description="In your time zone ({ownZone}).">
          <Input type="datetime-local" name="runAt" bind:value={runAt} min={local(new Date())} required />
        </Field>
      {:else}
        <div class="grid gap-4 sm:grid-cols-2">
          <Field label="How often">
            <Select
              name="frequency"
              bind:value={frequency}
              options={[
                { value: "hourly", label: "Every hour" },
                { value: "daily", label: "Every day" },
                { value: "weekdays", label: "Weekdays" },
                { value: "weekly", label: "Every week" },
                { value: "custom", label: "Custom (cron)" },
              ]}
            />
          </Field>
          {#if frequency === "hourly"}
            <Field label="At minute">
              <Input type="number" name="minute" min="0" max="59" bind:value={minute} />
            </Field>
          {:else if frequency === "custom"}
            <Field label="Cron">
              <Input
                name="cron"
                bind:value={customCron}
                placeholder="*/30 9-17 * * 1-5"
                autocomplete="off"
                spellcheck="false"
                class="font-mono"
              />
            </Field>
          {:else}
            <Field label="At">
              <Input type="time" name="time" bind:value={time} required />
            </Field>
          {/if}
          {#if frequency === "weekly"}
            <Field label="On">
              <Select
                name="weekday"
                bind:value={weekday}
                options={weekdays.map((label, index) => ({ value: String(index), label }))}
              />
            </Field>
          {/if}
          <Field label="Time zone" class={frequency === "weekly" ? "" : "sm:col-span-2"}>
            <Select name="timezone" bind:value={timezone} options={zones.map((value) => ({ value, label: value }))} />
          </Field>
          <Field label="Ends">
            <Select
              name="ends"
              bind:value={ends}
              options={[
                { value: "never", label: "Never" },
                { value: "until", label: "On a date" },
                { value: "count", label: "After a number of runs" },
              ]}
            />
          </Field>
          {#if ends === "until"}
            <Field label="Last run before">
              <Input type="datetime-local" name="until" bind:value={until} min={local(new Date())} />
            </Field>
          {:else if ends === "count"}
            <Field
              label="Runs"
              description={editing?.runs
                ? `${editing.runs} runs already completed. This is the total limit.`
                : undefined}
            >
              <Input type="number" name="maxRuns" min={(editing?.runs ?? 0) + 1} bind:value={maxRuns} />
            </Field>
          {/if}
        </div>
        {#if cron}
          <p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
            {describeCron(cron)}{describeCron(cron) === cron ? "" : ` · ${cron}`} in {timezone}. Runs at least 5 minutes
            apart.
          </p>
          <SchedulePreview {cron} {timezone} />
        {/if}
      {/if}
    </fieldset>

    {#if target === "new_thread" && kind === "recurring"}
      <Field label="While a previous run is working">
        <Select
          name="concurrency"
          bind:value={concurrency}
          options={[
            { value: "skip_if_running", label: "Skip the next run" },
            { value: "allow", label: "Start another thread" },
          ]}
        />
      </Field>
    {/if}
    <Field
      label="If a run is missed"
      description="After a gateway outage, or after 2 minutes without an eligible worker for a pool."
    >
      <Select
        name="missedPolicy"
        bind:value={missedPolicy}
        options={[
          { value: "run_once", label: "Run once when back" },
          { value: "skip", label: "Skip it" },
        ]}
      />
    </Field>

    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button onclick={() => (open = false)}>Cancel</Button>
      <Button type="submit" variant="primary" icon={editing ? "check" : "clock"} loading={busy}
        >{editing ? "Save changes" : "Schedule"}</Button
      >
    </DialogActions>
  </form>
</Dialog>
