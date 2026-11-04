import type { BotView, ChatEntry, ConversationView, ParticipantView } from "../model.ts";

/**
 * Made-up bots and chats for the dev-only gallery (`/dev/bots`). Never imported by production code:
 * the gallery route loads this through a dynamic import that only exists in dev builds.
 */

const now = Date.now();
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000);

const daysAgo = (days: number, hour: number, minute = 0) => {
  const d = new Date(now - days * 86_400_000);
  d.setHours(hour, minute, 0, 0);

  return d;
};

export const me: ParticipantView = { id: "me", kind: "user", name: "You" };

const bot = (id: string, name: string, description: string): BotView => ({ id, kind: "bot", name, description });

export const bots = {
  canopy: bot("bot-canopy", "Canopy Bot", "Merges pull requests once CI is green."),
  sync: bot("bot-sync", "Sync Bot", "Keeps development branches in sync."),
  release: bot("bot-release", "Release Bot", "Cuts releases and writes the notes."),
  docs: bot("bot-docs", "Docs Bot", "Keeps the docs in step with the code."),
  triage: bot("bot-triage", "Triage Bot", "Labels and routes new issues."),
  standup: bot("bot-standup", "Standup Bot", "Collects the daily standup."),
  infra: bot("bot-infra", "Infra Bot", "Watches the servers."),
  billing: bot("bot-billing", "Billing Bot", "Checks the monthly invoices."),
} satisfies Record<string, BotView>;

export const conversations: ConversationView[] = [
  {
    id: "c-canopy",
    kind: "direct",
    bots: [bots.canopy],
    lastMessage: { senderId: bots.canopy.id, text: "Kiedy mergujemy landing?", at: minutesAgo(3) },
    unread: 2,
    pinned: true,
    pinOrder: 0,
  },
  {
    id: "c-sync",
    kind: "direct",
    bots: [bots.sync],
    lastMessage: {
      senderId: bots.sync.id,
      text: "Upstream has 4 new commits; the fork is rebased.",
      at: minutesAgo(40),
    },
    unread: 0,
    pinned: true,
    pinOrder: 1,
  },
  {
    id: "c-launch",
    kind: "group",
    title: "Landing launch",
    bots: [bots.canopy, bots.sync, bots.docs],
    lastMessage: { senderId: bots.docs.id, text: "The changelog entry is ready for review.", at: minutesAgo(12) },
    unread: 3,
    pinned: true,
    pinOrder: 2,
  },
  {
    id: "c-release",
    kind: "direct",
    bots: [bots.release],
    lastMessage: { senderId: "me", text: "Hold the release until Monday.", at: daysAgo(1, 17, 5) },
    unread: 0,
    pinned: true,
    pinOrder: 3,
  },
  {
    id: "c-watch",
    kind: "watch",
    bots: [bots.canopy, bots.sync],
    lastMessage: { senderId: bots.sync.id, text: "Rebased. CI is running again.", at: minutesAgo(25) },
    unread: 0,
    pinned: false,
  },
  {
    id: "c-infra",
    kind: "group",
    title: "Infra on-call",
    bots: [bots.infra, bots.triage, bots.release, bots.billing],
    lastMessage: { senderId: bots.infra.id, text: "Disk on worker-2 is at 91%.", at: minutesAgo(95) },
    unread: 0,
    pinned: false,
  },
  {
    id: "c-docs",
    kind: "direct",
    bots: [bots.docs],
    lastMessage: {
      senderId: bots.docs.id,
      text: "I rewrote the quick start; three sections were out of date and one command no longer exists.",
      at: daysAgo(2, 10, 30),
    },
    unread: 0,
    pinned: false,
  },
  {
    id: "c-triage",
    kind: "direct",
    bots: [bots.triage],
    lastMessage: { senderId: bots.triage.id, text: "5 new issues labelled, 1 needs you.", at: daysAgo(9, 9, 15) },
    unread: 1,
    pinned: false,
  },
  { id: "c-standup", kind: "direct", bots: [bots.standup], unread: 0, pinned: false },
];

export const directEntries: ChatEntry[] = [
  {
    kind: "message",
    message: { id: "d1", senderId: "me", at: daysAgo(1, 18, 2), text: "Can you merge #441 once CI is green?" },
  },
  {
    kind: "message",
    message: {
      id: "d2",
      senderId: bots.canopy.id,
      at: daysAgo(1, 18, 3),
      text: "Sure. I set up a routine that checks every 10 minutes.",
    },
  },
  {
    kind: "event",
    event: {
      id: "d3",
      at: daysAgo(1, 18, 3),
      kind: "routine_created",
      text: "Created routine",
      detail: "Canopy: merge PR #441 after CI",
      actorId: bots.canopy.id,
    },
  },
  {
    kind: "message",
    message: {
      id: "d4",
      senderId: bots.canopy.id,
      at: daysAgo(1, 19, 40),
      text: "Merged **#441**.",
      links: [
        {
          url: "https://github.com/example/canopy/pull/441",
          title: "Settings from the gateway",
          kind: "pull_request",
          subtitle: "canopy#441",
        },
      ],
    },
  },
  {
    kind: "message",
    message: {
      id: "d5",
      senderId: "me",
      at: minutesAgo(16),
      text: "Stop the routine for #443, I'll merge it myself.\nAnd pause the other ones for today.",
    },
  },
  {
    kind: "event",
    event: {
      id: "d6",
      at: minutesAgo(15),
      kind: "routine_deleted",
      text: "Deleted routine",
      detail: "Canopy: scalenie PR #443 po CI",
      actorId: bots.canopy.id,
    },
  },
  {
    kind: "event",
    event: {
      id: "d7",
      at: minutesAgo(15),
      kind: "routines_disabled",
      text: "Disabled",
      detail: "3 routines",
      actorId: bots.canopy.id,
    },
  },
  {
    kind: "message",
    message: {
      id: "d8",
      senderId: bots.canopy.id,
      at: minutesAgo(14),
      text: "Done. Nothing will merge on its own today.",
    },
  },
  {
    kind: "message",
    message: {
      id: "d9",
      senderId: bots.canopy.id,
      at: minutesAgo(13),
      text: "Paused routines:\n\n- `merge-after-ci` for #445\n- nightly dependency bumps\n- stale branch cleanup",
    },
  },
  {
    kind: "event",
    event: {
      id: "d10",
      at: minutesAgo(5),
      kind: "relayed_message",
      text: "Message from Sync Bot",
      detail: "the landing branch is rebased",
      actorId: bots.sync.id,
    },
  },
  {
    kind: "message",
    message: {
      id: "d11",
      senderId: bots.canopy.id,
      at: minutesAgo(4),
      text: "Sync Bot rebased the landing branch and CI passed.",
      links: [
        {
          url: "https://github.com/example/canopy/pull/446",
          title: "Landing page",
          kind: "pull_request",
          subtitle: "canopy#446",
        },
        { url: "https://ci.example.com/runs/9182", title: "CI run 9182", kind: "web" },
      ],
    },
  },
  {
    kind: "question",
    question: {
      id: "d12",
      askedBy: bots.canopy.id,
      at: minutesAgo(3),
      prompt: "Kiedy mergujemy landing?",
      options: [
        { id: "now", label: "Teraz", description: "Merge as soon as you answer." },
        { id: "monday", label: "W poniedziałek rano", description: "I schedule it for 9:00." },
      ],
    },
  },
];

export const groupEntries: ChatEntry[] = [
  {
    kind: "event",
    event: { id: "g0", at: minutesAgo(70), kind: "joined", text: "Docs Bot joined", actorId: bots.docs.id },
  },
  {
    kind: "message",
    message: { id: "g1", senderId: "me", at: minutesAgo(65), text: "Let's ship the landing page today. What's left?" },
  },
  {
    kind: "message",
    message: {
      id: "g2",
      senderId: bots.sync.id,
      at: minutesAgo(64),
      text: "The branch is two commits behind `main`. I'll rebase it.",
    },
  },
  {
    kind: "message",
    message: { id: "g3", senderId: bots.canopy.id, at: minutesAgo(62), text: "I'll merge once CI is green." },
  },
  { kind: "message", message: { id: "g4", senderId: bots.canopy.id, at: minutesAgo(61), text: "Routine is set." } },
  {
    kind: "event",
    event: {
      id: "g5",
      at: minutesAgo(61),
      kind: "routine_created",
      text: "Created routine",
      detail: "Canopy: merge PR #446 after CI",
      actorId: bots.canopy.id,
    },
  },
  {
    kind: "question",
    question: {
      id: "g6",
      askedBy: bots.docs.id,
      at: minutesAgo(30),
      prompt: "Should the changelog mention the new pricing?",
      options: [
        { id: "yes", label: "Yes, in its own section" },
        { id: "no", label: "No, leave it out" },
      ],
      answer: { optionId: "yes", at: minutesAgo(28) },
    },
  },
  {
    kind: "message",
    message: {
      id: "g7",
      senderId: "me",
      at: minutesAgo(27),
      text: "Yes, but keep it short.",
      replyTo: { senderId: bots.docs.id, excerpt: "Should the changelog mention the new pricing?" },
    },
  },
  {
    kind: "message",
    message: { id: "g8", senderId: bots.sync.id, at: minutesAgo(14), text: "Rebased, CI is running." },
  },
  {
    kind: "message",
    message: {
      id: "g9",
      senderId: bots.docs.id,
      at: minutesAgo(12),
      text: "The changelog entry is ready for review:\n\n> **Pricing.** Plans now start at the team tier.",
      links: [
        {
          url: "https://github.com/example/canopy/pull/447",
          title: "Changelog: landing page",
          kind: "pull_request",
          subtitle: "canopy#447",
        },
      ],
    },
  },
  {
    kind: "message",
    message: {
      id: "g10",
      senderId: "me",
      at: minutesAgo(2),
      text: "Looks good, merging after lunch.",
      delivery: "sending",
    },
  },
];

export const watchEntries: ChatEntry[] = [
  {
    kind: "message",
    message: {
      id: "w1",
      senderId: bots.canopy.id,
      at: minutesAgo(48),
      text: "CI on #446 fails: the branch is behind `main`. Can you rebase it?",
    },
  },
  { kind: "message", message: { id: "w2", senderId: bots.sync.id, at: minutesAgo(47), text: "On it." } },
  {
    kind: "message",
    message: {
      id: "w3",
      senderId: bots.sync.id,
      at: minutesAgo(46),
      text: "Two conflicts in `apps/web/src/routes/+layout.svelte`. Resolving them the same way as in #441.",
    },
  },
  {
    kind: "message",
    message: { id: "w4", senderId: bots.canopy.id, at: minutesAgo(40), text: "Fine by me. Ping me when it's pushed." },
  },
  {
    kind: "event",
    event: { id: "w5", at: minutesAgo(26), kind: "info", text: "Sync Bot pushed 2 commits", detail: "landing" },
  },
  {
    kind: "message",
    message: {
      id: "w6",
      senderId: bots.sync.id,
      at: minutesAgo(25),
      text: "Rebased. CI is running again.",
      links: [{ url: "https://ci.example.com/runs/9182", title: "CI run 9182", kind: "web" }],
    },
  },
];

/** Gallery-only: a picture instead of a mascot. */
export const pictureBot: BotView = {
  id: "bot-picture",
  kind: "bot",
  name: "Picture Bot",
  imageUrl:
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f97316"/><stop offset="1" stop-color="#db2777"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/></svg>',
    ),
};
