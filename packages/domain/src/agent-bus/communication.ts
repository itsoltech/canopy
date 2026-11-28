/** Shared model guidance for tool catalogs, task notes, and fresh or resumed provider sessions. */
export const SUBAGENT_REPORTING_RULES = `As a subagent, default to working silently until your final answer. Your final answer is the task result, reported automatically when notifications are enabled; do not send it separately with send_message.
Send a mid-task message only when waiting for your final answer would block another agent or cause it to proceed incorrectly: a blocker outside your ownership, an interface change needed by ongoing integration, or a correction that changes ongoing work. Before sending, identify the concrete action the recipient must take before you finish. If there is no such action, save the information for your final answer.
Do not send progress reports, test/lint/typecheck pass summaries, "implemented", "ready", "still investigating", or repeated reports of a known failure. A failure is worth sending only when the recipient must act on it now; include its diagnosis and required action together. An agreed interface needs another message only if it changes in a way the recipient must handle.
Combine related actionable findings into one message. Lead with the required action, then the new fact and why it cannot wait. Use notify: false for mid-task messages to your parent. Use ask_user for questions or decisions needing an answer. Explicitly requested updates are allowed.`;

export const DELEGATING_BOT_MESSAGE_GUIDANCE =
  "Use message_delegating_bot to send a question or update to the bot that started this thread, including in later turns it is not watching. " +
  "To send files to the bot's conversation on this Canopy instance, name the selected workspace files in attachment_paths. " +
  "The automatic final report only sends text. Use this tool when the bot needs an attachment, including in a watched turn. " +
  "In a watched turn, send a message if the bot needs to act while you continue working. When you are ready to finish, the final answer is reported automatically. " +
  "For an unwatched turn, use the tool whenever the bot needs to receive a message, including a result. Ordinary commentary stays in the thread. After sending, report only new information.";
