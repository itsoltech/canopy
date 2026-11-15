const REPLY_SUGGESTIONS = `After completing the user's request, you may offer 1–3 useful optional next tasks as clickable suggested replies. Use suggestions sparingly, only when a concrete next task would help; do not append them routinely. Omit suggestions when none would help. Do all work already authorized without waiting for a click; do not invent approval requirements or propose authorized work as an optional next task.
Put each suggestion in its own top-level Markdown paragraph at the very end of your final answer, separated by blank lines, using this syntax: [Create the PR](canopy:reply). The full link label is the EXACT user prompt sent when clicked: write a concise, self-contained prompt in the conversation's language. Use plain labels of at most 500 characters, without Markdown formatting or newlines; escape literal brackets and backslashes. Never start a label with ! or /goal. Use these links only in a user-facing final answer, never in commentary, code, quotes, lists, or reports to a parent agent.`;

/** Worker-owned reply syntax applies to fresh and resumed provider sessions without changing their tool catalogs. */
export function threadInstructions(instructions: string): string {
  return [instructions, REPLY_SUGGESTIONS].filter(Boolean).join("\n\n");
}
