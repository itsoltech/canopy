/** Includes indirect thread access through project lifecycle, placement, schedules and settings. */
export const threadToolNames = new Set([
  "answer_interaction",
  "list_threads",
  "get_thread",
  "read_thread",
  "interrupt_thread",
  "archive_thread",
  "delete_thread",
  "fork_thread",
  "set_goal",
  "regenerate_title",
  "set_thread_permission",
  "list_background_tasks",
  "stop_background_task",
  "list_projects",
  "create_project",
  "rename_project",
  "archive_project",
  "add_workspace",
  "update_workspace",
  "remove_workspace",
  "start_thread",
  "send_message",
  "rename_thread",
  "set_thread_model",
  "list_directory",
  "create_schedule",
  "update_schedule",
  "set_schedule_status",
  "get_settings",
  "update_settings",
  "set_project_defaults",
]);

/** Mixed schedule tools also manage private bot reminders. */
export const usesThreadConnection = (name: string) =>
  threadToolNames.has(name) || name === "list_schedules" || name === "cancel_schedule";
