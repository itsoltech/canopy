import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ItemSchema, ui } from "@canopy/contracts";
import { taskListCurrent, taskListOf, taskListSummary } from "@canopy/domain/task-list";
import { isJsonObject, isString, listOf } from "@canopy/domain/json";

/** Characters of the current task in ui.Thread (sidebar, hover card); update_tasks titles are shorter anyway. */
const CURRENT_TASK = 200;

/**
 * The latest checklist item of the thread (update_tasks or a harness's own list) and the statuses of the turns
 * after its own, for ui.Thread.tasks (docs/agent-bus.md, "Lista zadań"). The predicate matches the partial index
 * thread_items_task_lists; the extra filters skip what taskListOf ignores, so LIMIT 1 finds the list in effect.
 */
export const THREAD_TASKS_SELECT = `(SELECT json_build_object('item', m.content, 'later', coalesce((
      SELECT json_agg(u.status) FROM turns o JOIN turns u ON u.thread_id = o.thread_id AND u.ordinal > o.ordinal
       WHERE o.id = m.turn_id AND u.rewind_id IS NULL), '[]'::json))
    FROM thread_items m
   WHERE m.thread_id = t.id AND m.parent_item_id IS NULL AND (
       m.type = 'todo_list'
       OR m.type = 'plan'
       OR (m.type = 'agent_bus_call' AND m.content->'agentBusCall'->>'toolName' = 'update_tasks')
       OR (m.type = 'tool_call' AND m.content->'toolCall'->>'name' IN ('TodoWrite', 'update_plan', 'todo_write')))
     AND m.turn_id IS NOT NULL
     AND NOT (m.type = 'plan' AND jsonb_array_length(coalesce(m.content->'plan'->'steps', '[]'::jsonb)) = 0)
     AND NOT (m.type = 'agent_bus_call' AND (m.status IN ('failed', 'declined')
       OR coalesce((m.content->'agentBusCall'->>'isError')::boolean, false)))
     AND NOT (m.type = 'tool_call' AND coalesce((m.content->'toolCall'->>'isError')::boolean, false))
     AND NOT EXISTS (SELECT 1 FROM turns r WHERE r.id = m.turn_id AND r.rewind_id IS NOT NULL)
   ORDER BY m.first_seq DESC LIMIT 1) AS task_list`;

/** ui.Thread.tasks: the list in short while it still describes current work, else absent. */
export function threadTasks(columns: JsonValue | null | undefined): ui.ThreadTasks | undefined {
  if (!isJsonObject(columns) || columns["item"] === undefined) return undefined;
  const later = listOf(columns["later"]).filter(isString);

  try {
    const tasks = taskListOf(fromJson(ItemSchema, columns["item"], { ignoreUnknownFields: true }));

    if (!tasks || tasks.steps.length === 0 || !taskListCurrent(tasks, later)) return undefined;
    const summary = taskListSummary(tasks);

    return create(ui.ThreadTasksSchema, {
      completed: summary.completed,
      total: summary.total,
      current: summary.current?.text.slice(0, CURRENT_TASK) ?? "",
    });
  } catch {
    return undefined;
  }
}
