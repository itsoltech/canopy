import { SETTINGS_REPLY_GUIDANCE, SUBAGENT_REPORTING_RULES } from "@canopy/domain";

const REPLY_SUGGESTIONS = `After completing the user's request, you may offer 1–3 useful optional next tasks as clickable suggested replies. Use suggestions sparingly, only when a concrete next task would help; do not append them routinely. Omit suggestions when none would help. Do all work already authorized without waiting for a click; do not invent approval requirements or propose authorized work as an optional next task.
Put each suggestion in its own top-level Markdown paragraph at the very end of your final answer, separated by blank lines, using this syntax: [Create the PR](canopy:reply). The full link label is the EXACT user prompt sent when clicked: write a concise, self-contained prompt in the conversation's language. Use plain labels of at most 500 characters, without Markdown formatting or newlines; escape literal brackets and backslashes. Never start a label with ! or /goal. Use these links only in a user-facing final answer, never in commentary, code, quotes, lists, or reports to a parent agent.`;

const ORCHESTRATION = `Clarifications to a working subagent belong in its current turn: use send_message with delivery: "steer". Reserve delivery: "queue" for a separate task. Delegate a self-contained task with its known interfaces and ownership up front; do not ask subagents for routine progress or repeated checks while they work. Do not send acknowledgments or requests to finalize work already reported. When a report adds no new findings or actions beyond what you have already told the user, finish without another user-facing message.`;

/** Worker-owned instructions apply to fresh and resumed provider sessions without changing their tool catalogs. */
export function threadInstructions(instructions: string): string {
  return [instructions, ORCHESTRATION, SUBAGENT_REPORTING_RULES, SETTINGS_REPLY_GUIDANCE, REPLY_SUGGESTIONS]
    .filter(Boolean)
    .join("\n\n");
}
