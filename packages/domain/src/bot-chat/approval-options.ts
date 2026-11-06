/** Shared wording for the web, desktop and native bot settings. */
export const BOT_APPROVAL_OPTIONS: { value: "safe" | "always" | "full_auto"; label: string; description: string }[] = [
  {
    value: "safe",
    label: "For actions that need care",
    description: "Connected account writes and sensitive actions ask first unless a rule allows them.",
  },
  {
    value: "always",
    label: "For every action",
    description: "Actions ask first unless a rule allows them. Platform reads run directly.",
  },
  {
    value: "full_auto",
    label: "Only protected actions (full auto)",
    description: "Other actions run without asking. Protected actions and questions still need you.",
  },
];

export const BOT_THREAD_PERMISSION_OPTIONS = [
  {
    value: "same_bot",
    label: "Same as the bot’s approvals",
    description: "Uses Ask first, or Full auto for a full auto bot. Local threads also use connected account rules.",
  },
  {
    value: "user_default",
    label: "Use my thread default",
    description: "Uses your thread permission default when the bot starts a thread.",
  },
  { value: "ask", label: "Ask first", description: "The agent asks before running tools that need approval." },
  {
    value: "read_only",
    label: "Read only",
    description: "The agent can read but cannot change files or connected accounts.",
  },
  {
    value: "accept_edits",
    label: "Accept edits",
    description: "File edits run directly. Other sensitive tools ask first.",
  },
  {
    value: "full_auto",
    label: "Full auto",
    description: "Thread tools run without asking, within the agent’s sandbox.",
  },
];
