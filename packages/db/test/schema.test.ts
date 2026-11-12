import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "../src/testing.ts";
import {
  completedTurn,
  failure,
  id,
  mainThread,
  query,
  runMigrations,
  startSchemaDb,
  stopSchemaDb,
  world,
} from "./support/schema.ts";

describe.skipIf(!dockerAvailable)("schema on PostgreSQL 17", () => {
  beforeAll(async () => {
    const applied = await startSchemaDb();
    expect(applied.map(([n, name]) => `${n}_${name}`)).toEqual([
      "1_init",
      "2_worker_config",
      "3_gateway_runtime",
      "4_agent_bus_runtime",
      "5_settings",
      "6_turn_sources",
      "7_turn_source_details",
      "8_one_start_per_turn",
      "9_models_effort_steer",
      "10_goals_background_harness",
      "11_goals_engine_cleanup",
      "12_worker_restart",
      "13_turn_end_sources",
      "14_turn_permission_mode",
      "15_provider_profiles",
      "16_attachments",
      "18_global_providers",
      "19_thread_reads",
      "20_fork_from_turn",
      "21_queue_manage",
      "22_thread_titles",
      "23_agent_senders",
      "24_background_task_notes",
      "25_ask_user",
      "26_sidebar_threads",
      "27_schedules_new_thread",
      "28_archive_cascade",
      "29_schedule_edit",
      "30_bus_notify_delivery",
      "31_bots",
      "32_scratch_projects",
      "33_bot_mentions",
      "34_bot_archive",
      "36_thread_secrets",
      "39_bot_routines",
      "40_bot_creation",
      "41_connectors",
      "42_answer_bot",
      "43_grok_provider",
      "44_worker_enrollment",
      "45_bot_handoffs",
      "46_mobile_devices",
      "47_worker_ssh",
      "48_linked_computers",
      "49_thread_mirrors",
      "50_shared_config",
      "51_linked_agents",
      "52_computer_routes",
      "53_computer_relay",
      "54_computer_moves",
      "55_network_access",
      "56_mobile_network",
      "57_agent_environment",
      "58_agent_skills",
      "59_agent_skill_sources",
      "60_agent_plugins",
      "61_proxies",
      "62_desktop_clients",
      "63_desktop_updates",
      "64_worker_enrollment_tags",
      "65_instance_connections",
      "66_worktrees",
      "67_worktree_lifecycle",
      "68_worktree_automation",
      "69_bot_errors",
      "70_bot_harness",
      "71_bot_harness_errors",
      "72_workspace_origin",
      "73_config_sync",
      "74_config_providers",
      "75_config_projects",
      "76_config_agent_environment",
      "77_config_connectors",
      "78_config_workers",
      "79_connector_errors",
      "80_full_access_mode",
      "81_connector_oauth_completion",
      "82_computer_route_withdrawn",
      "83_tailscale_https",
      "84_bot_approval_expiry",
      "85_interaction_deadlines",
      "86_git_heads",
      "87_worktree_branch_names",
      "88_thread_mirror_delta",
      "89_bot_approval_rules",
      "90_bot_approval_defaults",
      "91_bot_view_delta",
      "92_external_worktrees",
      "93_cli_imports",
      "94_cli_import_library",
      "95_bus_message_consumption",
      "96_consumed_bus_turns",
      "97_mirror_thread_metadata",
      "98_thread_read_metadata",
      "99_message_receipts",
      "100_history_read_indexes",
      "101_composer_turn_choices",
      "102_bot_composer",
      "103_queue_read_indexes",
      "104_database_retention",
      "105_retention_indexes",
      "106_polling_indexes",
      "107_lifecycle_read_indexes",
      "108_secret_delivery_batches",
      "109_secret_queue_indexes",
      "110_config_field_ancestry",
      "111_worker_event_quarantine",
      "112_workspace_copy",
      "113_github_accounts",
      "114_github_pull_requests",
      "115_github_detection",
      "116_github_full_read",
      "117_github_mutations",
      "118_github_reviews",
      "119_github_lifecycle",
      "120_thread_ranges",
      "121_thread_publication_failures",
      "122_thread_client_cursors",
      "123_thread_sync_diagnostics",
      "124_thread_range_lock_order",
      "125_inherited_access_mode",
      "124_thread_sync_time",
    ]);
  }, 60_000);

  afterAll(stopSchemaDb);

  test("migrations are idempotent", async () => {
    expect(await runMigrations()).toEqual([]);
  });

  test("release metadata fits existing JSONB without overwriting worker capabilities or user preferences", async () => {
    const w = await world();
    await query(`UPDATE workers SET capabilities = '{"providers":["codex"]}' WHERE id = $1`, [w.worker]);
    await query(
      `UPDATE workers SET capabilities = jsonb_set(capabilities, '{update}', '{"state":"queued","targetVersion":"2.0.0"}') WHERE id = $1`,
      [w.worker],
    );
    await query(`INSERT INTO user_settings (user_id, settings, version) VALUES ($1, '{"theme":"dark"}', 1)`, [w.user]);
    await query(
      `UPDATE user_settings SET settings = settings || '{"updateChannel":"v2"}', version = version + 1 WHERE user_id = $1`,
      [w.user],
    );
    expect(
      (await query<{ capabilities: unknown }>(`SELECT capabilities FROM workers WHERE id = $1`, [w.worker]))[0]
        ?.capabilities,
    ).toEqual({ providers: ["codex"], update: { state: "queued", targetVersion: "2.0.0" } });
    expect(
      (await query<{ settings: unknown }>(`SELECT settings FROM user_settings WHERE user_id = $1`, [w.user]))[0]
        ?.settings,
    ).toEqual({ theme: "dark", updateChannel: "v2" });
  });

  describe("agent bus", () => {
    const insertCall = `INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, tool, arguments, hops, notify, notify_status)
                        VALUES ($1, $2, $3, $4, '{}', $5, $6, $7)`;

    const insertBusTurn = `INSERT INTO turns (id, thread_id, ordinal, status, trigger, agent_call_id, hops, input)
                           VALUES ($1, $2, $3, $4, 'agent_bus', $5, $6, '{}')`;

    test("spawn: call -> agent side thread -> turn (hops 1) -> notify turn back in the caller (hops 2)", async () => {
      const w = await world();
      const main = await mainThread(w);
      const callerTurn = await completedTurn(w, main, ["plan"]);

      const call = id();
      await query(insertCall, [call, main, callerTurn, "spawn_thread", 1, true, "pending"]);
      const side = id();
      await query(
        `INSERT INTO threads (id, project_id, owner_user_id, kind, parent_thread_id, root_thread_id, depth, origin, spawned_by_call_id,
                              runtime, provider, worker_id, workspace_id, cwd, status)
         VALUES ($1, $2, $3, 'side', $4, $4, 1, 'agent', $5, 'worker', 'codex', $6, $7, '/repo', 'idle')`,
        [side, w.project, w.user, main, call, w.worker, w.workspace],
      );
      const sideTurn = id();
      await query(insertBusTurn, [sideTurn, side, 1, "running", call, 1]);
      await query(
        `UPDATE agent_bus_calls SET target_thread_id = $2, target_turn_id = $3, status = 'completed', completed_at = now() WHERE id = $1`,
        [call, side, sideTurn],
      );

      // The side thread finished: deliver the notification as a new turn in the caller.
      const notifyTurn = id();
      await query(insertBusTurn, [notifyTurn, main, 2, "queued", call, 2]);
      await query(`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = $2 WHERE id = $1`, [
        call,
        notifyTurn,
      ]);

      const [row] = await query<{ origin: string; spawned_by_call_id: string }>(
        `SELECT origin, spawned_by_call_id FROM threads WHERE id = $1`,
        [side],
      );

      expect(row).toEqual({ origin: "agent", spawned_by_call_id: call });
    });

    test("integrity rules", async () => {
      const w = await world();
      const main = await mainThread(w);
      const other = await mainThread(w);
      const turn = await completedTurn(w, main, ["x"]);
      const otherTurn = await completedTurn(w, other, ["y"]);

      // Agent-created thread must point at its spawn call.
      expect(
        await failure(
          `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, origin, runtime, provider, worker_id, workspace_id, cwd)
           VALUES ($1, $2, $3, 'main', $1, 'agent', 'worker', 'claude', $4, $5, '/repo')`,
          [id(), w.project, w.user, w.worker, w.workspace],
        ),
      ).toContain("threads_agent_origin");
      // Only spawn/send start turns and carry hops; notify only for them.
      expect(await failure(insertCall, [id(), main, turn, "send_message", null, false, null])).toContain(
        "agent_bus_calls_starts_turn",
      );
      expect(await failure(insertCall, [id(), main, turn, "get_thread", 1, false, null])).toContain(
        "agent_bus_calls_starts_turn",
      );
      expect(await failure(insertCall, [id(), main, turn, "get_thread", null, true, "pending"])).toContain(
        "agent_bus_calls_notify",
      );
      expect(await failure(insertCall, [id(), main, turn, "send_message", 1, true, null])).toContain(
        "agent_bus_calls_notify",
      );
      expect(await failure(insertCall, [id(), main, turn, "send_message", 1, true, "delivered"])).toContain(
        "agent_bus_calls_notify",
      );
      expect(await failure(insertCall, [id(), main, turn, "send_message", 1, true, "steering"])).toContain(
        "agent_bus_calls_notify",
      );
      expect(await failure(insertCall, [id(), main, turn, "send_message", 17, false, null])).toContain(
        "agent_bus_calls_hops_check",
      );
      // Goals are the harness's own: the bus has no goal tools (0011).
      expect(await failure(insertCall, [id(), main, turn, "propose_goal", null, false, null])).toContain(
        "agent_bus_calls_tool_check",
      );

      // A bus turn has hops > 0, a human turn has 0.
      const call = id();
      await query(insertCall, [call, main, turn, "send_message", 1, false, null]);
      expect(await failure(insertBusTurn, [id(), main, 2, "queued", call, 0])).toContain("turns_hops_by_trigger");
      // The notification turn must be in the caller's thread.
      const notified = id();
      await query(insertCall, [notified, main, turn, "send_message", 1, true, "pending"]);
      expect(
        await failure(`UPDATE agent_bus_calls SET notify_status = 'delivered', notified_turn_id = $2 WHERE id = $1`, [
          notified,
          otherTurn,
        ]),
      ).toContain("foreign key");
    });

    test("a turn end says its source: failed -> platform | harness, interrupted -> user | system (0013)", async () => {
      const w = await world();
      const main = await mainThread(w);
      const turn = await completedTurn(w, main, ["x"]);
      expect(await failure(`UPDATE turns SET error_source = 'harness' WHERE id = $1`, [turn])).toContain(
        "turns_error_source_failed",
      );
      expect(await failure(`UPDATE turns SET interrupt_source = 'system' WHERE id = $1`, [turn])).toContain(
        "turns_interrupt_source_interrupted",
      );
      expect(
        await failure(`UPDATE turns SET status = 'failed', error_source = 'model' WHERE id = $1`, [turn]),
      ).toContain("turns_error_source_check");
      await query(
        `UPDATE turns SET status = 'failed', error = 'unexpected status 401', error_source = 'harness', error_code = 'http_connection_failed:401' WHERE id = $1`,
        [turn],
      );
      await query(
        `UPDATE turns SET status = 'interrupted', error = NULL, error_source = NULL, error_code = NULL, interrupt_source = 'system' WHERE id = $1`,
        [turn],
      );
    });
  });

  describe("schedules", () => {
    const insertSchedule = `INSERT INTO schedules (id, thread_id, project_id, kind, prompt, run_at, cron, until, max_runs, next_run_at,
                                                   created_by_user_id, created_by_call_id, hops)
                            VALUES ($1, $2, (SELECT project_id FROM threads WHERE id = $2), $3, 'check CI', $4, $5, $6, $7, $8, $9, $10, $11)`;

    const soon = () => new Date(Date.now() + 600_000);

    test("user schedules may be open-ended; agent schedules must be bounded and extend the chain", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const turn = await completedTurn(w, thread, ["x"]);
      const call = id();
      await query(
        `INSERT INTO agent_bus_calls (id, source_thread_id, source_turn_id, tool, arguments) VALUES ($1, $2, $3, 'schedule_recurring', '{}')`,
        [call, thread, turn],
      );

      await query(insertSchedule, [
        id(),
        thread,
        "recurring",
        null,
        "0 9 * * 1-5",
        null,
        null,
        soon(),
        w.user,
        null,
        0,
      ]);
      await query(insertSchedule, [id(), thread, "recurring", null, "*/30 * * * *", null, 10, soon(), null, call, 1]);
      await query(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, call, 1]);

      expect(
        await failure(insertSchedule, [
          id(),
          thread,
          "recurring",
          null,
          "*/30 * * * *",
          null,
          null,
          soon(),
          null,
          call,
          1,
        ]),
      ).toContain("schedules_agent_bounded");
      expect(
        await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, call, 0]),
      ).toContain("schedules_agent_bounded");
      expect(
        await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), w.user, null, 2]),
      ).toContain("schedules_user_hops");
      expect(
        await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, soon(), null, null, 0]),
      ).toContain("schedules_one_creator");
      expect(
        await failure(insertSchedule, [id(), thread, "once", null, "0 9 * * *", null, null, soon(), w.user, null, 0]),
      ).toContain("schedules_kind_fields");
      expect(
        await failure(insertSchedule, [id(), thread, "once", soon(), null, null, null, null, w.user, null, 0]),
      ).toContain("schedules_active_has_next");
    });

    test("a fired schedule is a turn with trigger = schedule", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const schedule = id();
      await query(insertSchedule, [schedule, thread, "once", soon(), null, null, null, soon(), w.user, null, 0]);
      const insertTurn = `INSERT INTO turns (id, thread_id, ordinal, trigger, schedule_id, hops, input) VALUES ($1, $2, $3, $4, $5, 0, '{}')`;
      await query(insertTurn, [id(), thread, 1, "schedule", schedule]);
      expect(await failure(insertTurn, [id(), thread, 2, "schedule", null])).toContain("turns_schedule");
      expect(await failure(insertTurn, [id(), thread, 2, "user", schedule])).toContain("turns_");
    });
  });

  describe("goals", () => {
    const insertGoal = `INSERT INTO goals (id, thread_id, objective, status, created_by, created_by_user_id, token_budget, finished_at)
                        VALUES ($1, $2, 'Migrate auth', $3, $4, $5, $6, $7)`;

    test("one open goal per thread; finished goals do not block a new one", async () => {
      const w = await world();
      const thread = await mainThread(w);
      await query(insertGoal, [id(), thread, "achieved", "user", w.user, null, new Date()]);
      await query(insertGoal, [id(), thread, "active", "user", w.user, null, null]);
      expect(await failure(insertGoal, [id(), thread, "paused", "user", w.user, null, null])).toContain(
        "goals_one_open",
      );
    });

    test("goals the harness set by itself are tracked as they are (no approval or budget gate)", async () => {
      const w = await world();
      // Codex create_goal: the model set it, the platform records it (docs/goals.md).
      await query(insertGoal, [id(), await mainThread(w), "active", "provider", null, null, null]);
      await query(insertGoal, [id(), await mainThread(w), "active", "provider", null, 200_000, null]);
      // Users may set open-ended goals directly.
      await query(insertGoal, [id(), await mainThread(w), "active", "user", w.user, null, null]);
    });

    test("creator columns and finish time are consistent", async () => {
      const w = await world();
      expect(await failure(insertGoal, [id(), await mainThread(w), "active", "user", null, null, null])).toContain(
        "goals_creator",
      );
      expect(
        await failure(insertGoal, [id(), await mainThread(w), "active", "provider", w.user, null, null]),
      ).toContain("goals_creator");
      expect(await failure(insertGoal, [id(), await mainThread(w), "achieved", "user", w.user, null, null])).toContain(
        "goals_finished",
      );
    });

    test("no platform engine: no agent proposals, approvals or platform budgets (0011)", async () => {
      const w = await world();
      expect(await failure(insertGoal, [id(), await mainThread(w), "active", "agent", null, 100_000, null])).toContain(
        "goals_creator",
      );
      expect(await failure(insertGoal, [id(), await mainThread(w), "proposed", "user", w.user, null, null])).toContain(
        "goals_status_check",
      );

      const columns = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'goals' ORDER BY ordinal_position`,
      );

      expect(columns.map((c) => c.column_name)).toEqual([
        "id",
        "thread_id",
        "objective",
        "status",
        "token_budget",
        "tokens_used",
        "time_used_seconds",
        "turns_used",
        "last_reason",
        "native_state",
        "created_by",
        "created_by_user_id",
        "created_at",
        "updated_at",
        "finished_at",
        "native_status",
        "error",
        "error_at",
      ]);
    });

    test("goal turns (Claude /goal) point at their goal and do not count as hops", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const goal = id();
      await query(insertGoal, [goal, thread, "active", "user", w.user, null, null]);
      const insertTurn = `INSERT INTO turns (id, thread_id, ordinal, trigger, goal_id, hops, input) VALUES ($1, $2, $3, 'goal', $4, $5, '{}')`;
      await query(insertTurn, [id(), thread, 1, goal, 0]);
      expect(await failure(insertTurn, [id(), thread, 2, null, 0])).toContain("turns_goal");
      expect(await failure(insertTurn, [id(), thread, 2, goal, 1])).toContain("turns_hops_by_trigger");
    });
  });

  describe("worker configuration (0002)", () => {
    const upsert = `INSERT INTO worker_configs (worker_id, version, config, updated_by) VALUES ($1, $2, $3::jsonb, $4)
                    ON CONFLICT (worker_id) DO UPDATE SET version = EXCLUDED.version, config = EXCLUDED.config, updated_at = now()`;

    test("every new version lands in history; a change without a higher version is refused", async () => {
      const w = await world();
      await query(upsert, [w.worker, 1, '{"allowedRoots":["/a"]}', w.user]);
      await query(upsert, [w.worker, 2, '{"allowedRoots":["/a","/b"]}', w.user]);
      expect(await failure(upsert, [w.worker, 2, '{"allowedRoots":[]}', w.user])).toContain("higher version");
      expect(await failure(upsert, [w.worker, 1, '{"allowedRoots":["/a","/b"]}', w.user])).toContain("cannot go back");

      const history = await query<{ version: string }>(
        `SELECT version FROM worker_config_history WHERE worker_id = $1 ORDER BY version`,
        [w.worker],
      );

      expect(history.map((h) => Number(h.version))).toEqual([1, 2]);
    });

    test("the applied report cannot be ahead of the sent version and is recorded as a whole", async () => {
      const w = await world();
      await query(upsert, [w.worker, 3, "{}", w.user]);
      const apply = `UPDATE worker_configs SET applied_version = $2, applied_ok = $3, applied_at = $4 WHERE worker_id = $1`;
      expect(await failure(apply, [w.worker, 4, true, new Date()])).toContain("worker_configs_applied_not_ahead");
      expect(await failure(apply, [w.worker, 3, true, null])).toContain("worker_configs_applied_together");
      await query(apply, [w.worker, 3, false, new Date()]);
    });

    test("secrets: unique name per owner (platform-wide too); a secret in use cannot be deleted", async () => {
      const w = await world();
      const insertSecret = `INSERT INTO secrets (id, owner_user_id, name, ciphertext, key_id, created_by) VALUES ($1, $2, $3, '\\x00', 'k1', $4)`;
      const secret = id();
      await query(insertSecret, [secret, w.user, "cliproxy-key", w.user]);
      expect(await failure(insertSecret, [id(), w.user, "cliproxy-key", w.user])).toContain("secrets_owner_name");
      await query(insertSecret, [id(), null, `platform-${secret.slice(-6)}`, w.user]);
      expect(await failure(insertSecret, [id(), null, `platform-${secret.slice(-6)}`, w.user])).toContain(
        "secrets_owner_name",
      );
      expect(await failure(insertSecret, [id(), w.user, "Bad Name!", w.user])).toContain("secrets_name_check");

      await query(upsert, [w.worker, 1, `{"profiles":[{"id":"proxy","apiKey":{"secretRef":"${secret}"}}]}`, w.user]);
      await query(`INSERT INTO worker_config_secrets (worker_id, secret_id) VALUES ($1, $2)`, [w.worker, secret]);
      expect(await failure(`DELETE FROM secrets WHERE id = $1`, [secret])).toContain("foreign key");
    });
  });

  describe("shared configuration (0075)", () => {
    test("unlinking removes the checkpoint and retains shared records and history", async () => {
      const w = await world();
      const node = `peer-${id()}`;
      await query(
        `INSERT INTO computer_peers (owner_user_id, node_id, name, certificate, fingerprint) VALUES ($1, $2, 'B', 'c', 'f')`,
        [w.user, node],
      );
      await query(`INSERT INTO config_items (owner_user_id,kind,global_id,revision) VALUES ($1,'project','test',1)`, [
        w.user,
      ]);
      await query(`INSERT INTO config_peer_cursors (owner_user_id,node_id,cursor) VALUES ($1,$2,'epoch:1')`, [
        w.user,
        node,
      ]);
      await query(
        `INSERT INTO config_history (owner_user_id,kind,global_id,field,value,hlc,node_id,notice_node_id)
                   VALUES ($1,'project','test','name','"Old name"','1.0.test',$2,$2)`,
        [w.user, node],
      );
      expect(
        await failure(
          `INSERT INTO config_peer_cursors (owner_user_id,node_id,cursor) VALUES ($1,'unknown','epoch:1')`,
          [w.user],
        ),
      ).toContain("foreign key");
      await query(`DELETE FROM computer_peers WHERE owner_user_id = $1 AND node_id = $2`, [w.user, node]);
      expect(await query(`SELECT 1 FROM config_peer_cursors WHERE owner_user_id = $1`, [w.user])).toHaveLength(0);
      expect(await query(`SELECT 1 FROM config_history WHERE owner_user_id = $1`, [w.user])).toHaveLength(1);
      expect(await query(`SELECT 1 FROM config_items WHERE owner_user_id = $1`, [w.user])).toHaveLength(1);
      expect(
        await query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'computer_shared_%'`),
      ).toHaveLength(0);
    });
  });

  describe("worker records (0078)", () => {
    test("worker and computer records name their home; copies stay after unlinking until the group prunes them", async () => {
      const w = await world();
      const node = "b".repeat(64);
      await query(
        `INSERT INTO computer_peers (owner_user_id, node_id, name, certificate, fingerprint) VALUES ($1, $2, 'B', 'c', 'f')`,
        [w.user, node],
      );
      const insert = `INSERT INTO config_items (owner_user_id,kind,global_id,home_node_id,revision) VALUES ($1,$2,$3,$4,1)`;
      expect(await failure(insert, [w.user, "worker", id(), ""])).toContain("config_items_home_named");
      expect(await failure(insert, [w.user, "computer", node, ""])).toContain("config_items_home_named");
      await query(insert, [w.user, "worker", id(), node]);
      await query(insert, [w.user, "instance", "claude:native", ""]);
      await query(`DELETE FROM computer_peers WHERE owner_user_id = $1 AND node_id = $2`, [w.user, node]);
      expect(
        await query(`SELECT kind FROM config_items WHERE owner_user_id = $1 AND home_node_id = $2`, [w.user, node]),
      ).toHaveLength(1);
    });
  });

  describe("computer routes (0052)", () => {
    test("routes have a known source, belong to a linked computer and go away with it", async () => {
      const w = await world();
      const node = `peer-${id()}`;
      await query(
        `INSERT INTO computer_peers (owner_user_id, node_id, name, certificate, fingerprint) VALUES ($1, $2, 'B', 'c', 'f')`,
        [w.user, node],
      );
      const insert = `INSERT INTO computer_routes (owner_user_id, node_id, address, source) VALUES ($1, $2, $3, $4)`;
      await query(insert, [w.user, node, "https://192.168.1.20:4100", "lan"]);
      await query(insert, [w.user, node, "https://laptop.example:4100", "manual"]);
      expect(await failure(insert, [w.user, node, "https://10.0.0.2:4100", "guessed"])).toContain(
        "computer_routes_source_check",
      );
      expect(await failure(insert, [w.user, "unknown", "https://10.0.0.2:4100", "lan"])).toContain("foreign key");
      await query(`DELETE FROM computer_peers WHERE owner_user_id = $1 AND node_id = $2`, [w.user, node]);
      expect(await query(`SELECT 1 FROM computer_routes WHERE owner_user_id = $1`, [w.user])).toHaveLength(0);
    });
  });

  describe("computer relay (0053)", () => {
    test("indirect peers cannot be trust pins; owner-scoped grants and mirrors cascade on unlink", async () => {
      const w = await world();
      const other = await world();
      const via = `via-${id()}`;
      const home = `home-${id()}`;
      const recipient = `recipient-${id()}`;
      const peer = `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint) VALUES ($1,$2,'direct','certificate','pin')`;
      await query(peer, [w.user, via]);
      await query(peer, [w.user, recipient]);
      const indirect = `INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint,via_node_id,relay_role) VALUES ($1,$2,'indirect',$3,'',$4,'home')`;
      expect(await failure(indirect, [w.user, home, "certificate", via])).toContain("computer_relay_role");
      expect(await failure(indirect, [other.user, home, "", via])).toContain("foreign key");
      await query(indirect, [w.user, home, "", via]);
      await query(`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES ($1,$2)`, [w.user, home]);
      const grant = `INSERT INTO computer_relay_grants VALUES ($1,$2,$3)`;
      await query(grant, [w.user, recipient, via]);
      expect(await failure(grant, [other.user, recipient, via])).toContain("foreign key");
      expect(await failure(grant, [w.user, recipient, recipient])).toContain("check");
      await query(`DELETE FROM computer_peers WHERE owner_user_id=$1 AND node_id=$2`, [w.user, via]);
      expect(
        await query(`SELECT 1 FROM computer_peers WHERE owner_user_id=$1 AND node_id=$2`, [w.user, home]),
      ).toHaveLength(0);
      expect(await query(`SELECT 1 FROM computer_mirror_state WHERE owner_user_id=$1`, [w.user])).toHaveLength(0);
      expect(await query(`SELECT 1 FROM computer_relay_grants WHERE owner_user_id=$1`, [w.user])).toHaveLength(0);
    });
  });

  describe("computer moves (0054)", () => {
    test("nothing starts on a frozen thread or bot; one unfinished move per thing; sides keep their own states", async () => {
      const w = await world();
      const thread = await mainThread(w);
      const turn = `INSERT INTO turns (id, thread_id, ordinal, trigger, author_user_id, input) VALUES ($1, $2, $3, 'user', $4, '{}')`;
      await query(turn, [id(), thread, 1, w.user]);
      await query(`UPDATE threads SET moved_to = 'target' WHERE id = $1`, [thread]);
      expect(await failure(turn, [id(), thread, 2, w.user])).toContain("moving to another computer");
      await query(`UPDATE threads SET moved_to = NULL WHERE id = $1`, [thread]);
      await query(turn, [id(), thread, 2, w.user]);
      const bot = id();
      await query(
        `INSERT INTO bots (id, owner_user_id, client_request_id, configuration, provider, provider_instance, moved_to) VALUES ($1, $2, 'r', '{}', 'codex', 'native', 'target')`,
        [bot, w.user],
      );
      expect(
        await failure(`INSERT INTO bot_turns (id, bot_id, client_request_id, input) VALUES ($1, $2, 'c', 'x')`, [
          id(),
          bot,
        ]),
      ).toContain("moving to another computer");
      const move = `INSERT INTO computer_moves (owner_user_id, id, role, peer_node_id, kind, item_id, state) VALUES ($1, $2, $3, 'peer', 'thread', $4, $5)`;
      await query(move, [w.user, id(), "source", thread, "preparing"]);
      expect(await failure(move, [w.user, id(), "target", thread, "prepared"])).toContain("computer_moves_active");
      await query(move, [w.user, id(), "source", thread, "aborted"]);
      expect(await failure(move, [w.user, id(), "source", bot, "prepared"])).toContain("check");
      expect(
        await failure(
          `INSERT INTO computer_moves (owner_user_id, id, role, peer_node_id, kind, item_id, state, payload) VALUES ($1, $2, 'source', 'p', 'bot', $3, 'aborted', '\\x00')`,
          [w.user, id(), bot],
        ),
      ).toContain("check");
    });
  });

  describe("network access (0055)", () => {
    test("one row per gateway, a valid port and a bounded list of names", async () => {
      const w = await world();
      const insert = `INSERT INTO network_access (owner_user_id, port, hostnames) VALUES ($1, $2, $3)`;
      expect(await failure(insert, [w.user, 0, []])).toContain("check");
      expect(await failure(insert, [w.user, 65536, []])).toContain("check");
      expect(await failure(insert, [w.user, 24000, Array.from({ length: 9 }, (_, i) => `host-${i}`)])).toContain(
        "check",
      );
      await query(insert, [w.user, 24000, ["laptop.tailnet.ts.net"]]);
      expect(await query(`SELECT enabled FROM network_access`)).toEqual([{ enabled: false }]);
      // HTTPS over Tailscale (0083): off by default, real ports, the recorded Serve entry is an object.
      expect(await query(`SELECT tailscale_https, tailscale_https_port, tailscale_serve FROM network_access`)).toEqual([
        { tailscale_https: false, tailscale_https_port: null, tailscale_serve: null },
      ]);
      expect(await failure(`UPDATE network_access SET tailscale_https_port = 0`)).toContain("check");
      expect(await failure(`UPDATE network_access SET tailscale_front_port = 70000`)).toContain("check");
      expect(await failure(`UPDATE network_access SET tailscale_serve = '[]'`)).toContain("check");
      expect(await failure(insert, [w.user, 24001, []])).toContain("network_access_pkey");
      await query(`DELETE FROM network_access`);
    });
  });

  describe("worktrees (0064)", () => {
    test("one settings row per scope; one live worktree per path; a removed worktree frees its path", async () => {
      const w = await world();
      const scope = `INSERT INTO worktree_settings (owner_user_id, project_id, worker_id, settings) VALUES ($1, $2, $3, '{}')`;
      await query(scope, [w.user, null, null]);
      await query(scope, [w.user, w.project, null]);
      await query(scope, [w.user, w.project, w.worker]);
      expect(await failure(scope, [w.user, null, null])).toContain("worktree_settings_scope");
      expect(await failure(scope, [w.user, w.project, w.worker])).toContain("worktree_settings_scope");
      expect(
        await failure(
          `INSERT INTO worktree_settings (owner_user_id, project_id, worker_id, settings) VALUES ($1, NULL, $2, '[]')`,
          [w.user, w.worker],
        ),
      ).toContain("check");

      const insert = `INSERT INTO worktrees (id, owner_user_id, project_id, workspace_id, worker_id, repo_root, path, branch)
                      VALUES ($1, $2, $3, $4, $5, '/repo', '/data/worktrees/repo/a', 'canopy/a')`;

      const first = id();
      await query(insert, [first, w.user, w.project, w.workspace, w.worker]);
      expect(await failure(insert, [id(), w.user, w.project, w.workspace, w.worker])).toContain("worktrees_live_path");
      await query(`UPDATE worktrees SET removed_at = now() WHERE id = $1`, [first]);
      const live = id();
      await query(insert, [live, w.user, w.project, w.workspace, w.worker]);
      const thread = await mainThread(w);
      expect(await failure(`UPDATE threads SET worktree_id = $2 WHERE id = $1`, [thread, first])).toContain(
        "immutable",
      );

      const inWorktree = `INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, runtime, provider, worker_id, workspace_id, cwd, status, worktree_id)
        VALUES ($1, $2, $3, 'main', $1, 'worker', 'codex', $4, $5, $6, 'idle', $7)`;

      expect(await failure(inWorktree, [id(), w.project, w.user, w.worker, w.workspace, "/repo", live])).toContain(
        "workspace worktree and path",
      );
      expect(
        await failure(inWorktree, [id(), w.project, w.user, w.worker, w.workspace, "/data/worktrees/repo/a", first]),
      ).toContain("workspace worktree and path");
      await query(inWorktree, [id(), w.project, w.user, w.worker, w.workspace, "/data/worktrees/repo/a", live]);
    });
  });

  describe("agents", () => {
    test("scope/owner and kind/provider are consistent", async () => {
      const w = await world();

      const insert = `INSERT INTO agents (id, scope, owner_user_id, kind, provider, name, slug, created_by)
                      VALUES ($1::uuid, $2, $3, $4, $5, 'A', $1::text, $6)`;

      expect(await failure(insert, [id(), "global", w.user, "sdk", "claude", w.user])).toContain("agents_scope_owner");
      expect(await failure(insert, [id(), "private", w.user, "sdk", "anthropic", w.user])).toContain(
        "agents_kind_provider",
      );
      await query(insert, [id(), "global", null, "sdk", "codex", w.user]);
      await query(insert, [id(), "private", w.user, "chat", "openai", w.user]);
    });
  });
});
