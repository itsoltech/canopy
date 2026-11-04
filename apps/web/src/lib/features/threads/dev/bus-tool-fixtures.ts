import type { Item } from "@canopy/contracts";
import { bus, GALLERY_THREAD_ID, OTHER, SIDE, summary } from "./tool-fixture-kit.ts";

/** Agent bus calls over threads: read, spawn, message, wait and list. */
export const busThreadItems = (): Item[] => [
  bus(
    "read-thread",
    "read_thread",
    { thread_id: OTHER, limit: 10 },
    {
      entries: [
        {
          seq: 3,
          type: "user_message",
          userMessage: {
            text: "Hej",
            clientId: "01a198ce-fe6d-77c3-b110-8d25414fb489",
            authorUserId: "01a1981a-c5b8-734c-a479-d714b09c22ae",
          },
        },
        { seq: 9, type: "agent_message", agentMessage: { text: "Hej! What can I help you with today?" } },
        { seq: 12, type: "user_message", userMessage: { text: "szybko odpisujesz" } },
        { seq: 20, type: "command_execution", commandExecution: { command: "ls -A /tmp/canopy-stack/code" } },
        {
          seq: 31,
          type: "agent_message",
          agentMessage: {
            text: "Dzięki! W czym mogę pomóc? Widzę, że jesteś w repozytorium `/tmp/canopy-stack/code`.",
          },
        },
      ],
      nextSeq: 31,
    },
    { target: OTHER },
  ),
  bus(
    "spawn",
    "spawn_thread",
    {
      title: "Lister",
      prompt: "Run `ls -A` in the current directory and report the file names it prints. Do not modify anything.",
      permission_mode: "read_only",
    },
    {
      thread_id: SIDE,
      turn_id: "01a19868-b268-769b-8120-adea076eab3a",
      model: "",
      effort: "",
      permission_mode: "read_only",
      note: "The side thread is working.",
    },
  ),
  bus(
    "send",
    "send_message",
    { thread_id: SIDE, prompt: "Also count the **hidden** files.", delivery: "steer" },
    { thread_id: SIDE, turn_id: "x", delivery: "steer", note: "The message joins the turn that is running now." },
    { target: SIDE },
  ),
  bus(
    "wait",
    "wait_threads",
    { thread_ids: [SIDE, OTHER], until: "all", timeout_seconds: 120 },
    {
      done: true,
      threads: [
        summary("Lister", "idle", "There are 4 entries: demo, goal-check.txt, .git, README.md."),
        summary("Hej", "failed", "", { last_turn: { turn_id: "t", status: "failed", reason: "rate limited" } }),
      ],
    },
  ),
  bus(
    "get",
    "get_thread",
    { thread_id: SIDE },
    summary("Lister", "running", "", { waiting_for_user: 1, queued_turns: 2 }),
    { target: SIDE },
  ),
  bus("list", "list_threads", { scope: "children" }, { threads: [summary("Lister", "idle", "4 entries.")] }),
  bus(
    "agents",
    "list_agents",
    {},
    {
      agents: [],
      note: "No agent catalog yet: spawn_thread starts a copy of you (same provider, model and settings).",
    },
  ),
];

/** Agent bus schedules, interactions, interrupts and a refused call. */
export const busControlItems = (): Item[] => [
  bus(
    "wakeup",
    "schedule_wakeup",
    { delay_seconds: 60, prompt: "Reply with the single word PING" },
    {
      schedule_id: "01a19856-ff8e-7015-923e-0d6cb862d72a",
      thread_id: GALLERY_THREAD_ID,
      next_run_at: "2026-11-01T18:21:00.781Z",
    },
  ),
  bus(
    "recurring",
    "schedule_recurring",
    {
      cron: "0 9 * * 1-5",
      timezone: "Europe/Warsaw",
      prompt: "Check CI on main and summarise failures.",
      max_runs: 20,
    },
    {
      schedule_id: "s",
      thread_id: GALLERY_THREAD_ID,
      next_run_at: "2026-11-03T08:00:00.000Z",
      cron: "0 9 * * 1-5",
      timezone: "Europe/Warsaw",
    },
  ),
  bus(
    "interactions",
    "list_interactions",
    {},
    {
      interactions: [
        {
          request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b",
          thread_id: SIDE,
          kind: "permission",
          tool_name: "Bash",
          request: { command: "rm -rf node_modules", cwd: "/repo" },
        },
      ],
    },
  ),
  bus(
    "answer",
    "answer_interaction",
    {
      request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b",
      response: "deny",
      message: "Do not delete dependencies; run the tests instead.",
    },
    { request_id: "01a19856-ff8e-7015-923e-0d6cb862d72b", status: "declined" },
  ),
  bus("interrupt", "interrupt_thread", { thread_id: SIDE }, { thread_id: SIDE, interrupted: true }, { target: SIDE }),
  bus(
    "refused",
    "close_thread",
    { thread_id: OTHER },
    { error: "close_thread: only threads you spawned can be closed" },
    { isError: true, target: OTHER },
  ),
];
