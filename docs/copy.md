# Canopy — UI copy

These rules apply to every user-facing text in Canopy. Every feature that changes UI
text runs the copy audit (§8) before its PR; the PR does not wait for a separate copy
review. This document is in English, like the UI it describes.

Related: UI rules in `AGENTS.md`, [appearance.md](appearance.md).

## 1. Canopy's voice in one paragraph

Short, clear, precise. We say what happened and what to do next, then stop. Users get
the one piece of information they need, not an information dump: a crowded screen
discourages more than a missing description. We are not cold, though: we write like an
attentive colleague who knows the system, and very rarely, in odd, curious or happy
moments, we allow ourselves a warm, human sentence (§6). Inspiration: ASD-STE100
(Simplified Technical English), adapted to an app for technical people.

## 2. Core rules

1. **One idea per sentence.** Two ideas, two sentences. A semicolon or a dash is usually
   two sentences in disguise.
2. **Sentence length.** Aim for 15 words or fewer. Hard limits: 20 for instructions and
   procedures, 25 for descriptions. A setting description is one sentence. An empty
   state is a title plus at most 2 sentences.
3. **Active voice, present tense.** `Canopy restarts the worker`, not
   `The worker will be restarted`. No "will" where the present tense works.
4. **Imperative for actions.** `Check the connection, then retry.` No "please",
   "simply", "just" or "you may want to".
5. **Plain words with one meaning.** `use` (not utilize), `start` (not initiate),
   `stop` (not terminate), `show` (not display), `need` (not require), `about`
   (not approximately). One word means one thing across the whole app (§3).
6. **What happened, then what to do.** Every error and warning ends with an action or a
   clear "nothing to do". A button can be that action; then the text doesn't repeat it
   word for word.
7. **No blame.** Not `You entered an invalid URL`, but
   `Enter a URL that starts with https://`. Don't blame a provider either, unless we know
   for sure.
8. **No internal jargon.** Names of protocols, proto fields, error classes and processes
   (`gRPC`, `WorkerLink`, `stream_cut_off`, `sidecar`, `BFF`) appear only in details
   ("Show details") or when the user has to act on them (for example `worker.json`,
   `0600`, a path to a CLI).
9. **Numbers, units, dates.** Digits instead of words (`3 threads`), a space before the
   unit (`500 ms`, `1.2 GB`), relative time for recent events (`2 min ago`), absolute
   time for older ones. Format with `Intl`/`toLocale*`, never by hand. Plurals are
   correct (`1 thread`, `2 threads`).
10. **Sentence case** everywhere (titles, buttons, menus): `Add worker`, not
    `Add Worker`. Proper names stay as they are (Canopy, Claude, PostgreSQL).
11. **Punctuation.** Sentences in descriptions end with a period. Titles, buttons,
    labels, menu items and short statuses have none. Use the ellipsis `…` (one
    character) only for an ongoing action (`Starting Canopy…`). Use typographic quotes
    `“…”` around names the user chose. Settings paths look like
    `Settings → Network access`.
12. **Never say the same thing twice.** If the title says "Up to date", the description
    doesn't start with "Everything is up to date". A badge and a sentence with the same
    word: remove one.

## 3. Glossary

Use exactly these words. The synonyms in the right column are banned in the UI (they may
appear only as the literal name used by an external tool).

| Term | Meaning | Don't write |
|---|---|---|
| thread | a conversation with an agent in a project directory | chat, conversation (those are bot words), session |
| side thread | a thread branched off another thread | sub-thread, child thread, branch |
| turn | one request and the agent's answer in a thread | run, request, round |
| agent | Claude, Codex or Grok working in a thread | assistant, AI, model (a model is something else) |
| model | the model an agent uses | engine, LLM |
| agent CLI | the provider's tool installed on a worker | provider CLI, binary, tool |
| provider | Anthropic, OpenAI, xAI and their equivalents | vendor, backend |
| instance | configured access to a provider (Settings → Providers) | account, connection |
| profile | how an agent reaches its model | config, preset |
| proxy | a CLIProxyAPI instance from Settings → Proxies | relay, tunnel |
| gateway | Canopy's central service that the UI connects to | server, backend, hub |
| worker | the Canopy process that runs agents on a computer | runner, agent host, node |
| computer | a physical machine running Canopy or a worker | machine, host, box, node |
| device | a phone or tablet paired with Canopy | phone app, client |
| project | a set of directories (workspaces) on workers | repo, repository |
| workspace | a project's directory on one worker | folder, path |
| directory | a directory on disk | folder (exception: a "skill folder" picked in the file manager) |
| worktree | a git worktree that Canopy creates | branch copy, checkout |
| bot | a conversational partner on the gateway that remembers the conversation | assistant, agent |
| connected account | an external app account from Settings → Connectors | integration, service, app login |
| schedule | a scheduled message or wake-up | cron, job, timer |
| skill, plugin, marketplace | items in Agent environment | extension, add-on |
| update channel | Stable, Beta, Nightly | track, ring, branch |

"host" stays only as part of a network address (`host:port`).

## 4. Patterns

### 4.1 Buttons and menu items

A verb first, a concrete object, 1–3 words. A confirmation button repeats the verb from
the dialog title, never "OK" or "Yes".

| Good | Bad |
|---|---|
| `Add worker` | `New` |
| `Delete thread` | `Yes` / `Confirm` |
| `Check proxy` | `Check proxy (Test connection)` |
| `Restart to update` | `Restart now and install the update` |

### 4.2 Settings: title plus one sentence

The title names the thing (a noun). The description says what it affects or when it
applies. It doesn't repeat the title and doesn't describe the control.

- Good: `Update channel` — `A more stable channel can install an older version. Canopy asks first.`
- Bad: `Update channel` — `Choose the update channel for updates.`

### 4.3 Empty states

Title: what lives here (`No schedules yet`). Description: what this place is for and how
to fill it, at most 2 sentences. An action, if there is one: a single button.

- Good: `No workers yet` — `Add a worker to run Claude, Codex or Grok on a computer you control.`
- Bad: `Nothing here!` — `It looks like you haven't added any workers yet. Workers are…` (3 paragraphs)

### 4.4 Errors

Order: **what happened · why (if it helps) · what to do · details on demand**.

- Title: short, no "Error:" and no exclamation mark (`Could not finish this turn`).
- Body: 1–2 sentences; the last one is the action.
- Technical details (code, source, original message) go behind `Show details`, with a
  copy button. Redacted: no secrets.
- Banned: `Something went wrong`, `An error occurred`, `Oops`, and
  `Please try again later` without a reason.

| Good | Bad |
|---|---|
| `Canopy could not reach the provider, or the request timed out. Check the connection, then retry.` | `Network error (ECONNRESET). Please try again.` |
| `This model is not available for this provider. Choose a different model.` | `The selected model is unavailable for this provider instance.` |

### 4.5 Confirmations and irreversible actions

The title is a question with a verb (`Delete thread?`). The body says what exactly
disappears or stops working, what stays, and whether it can be undone. One effect per
sentence. The button uses the same verb and object, `danger` variant; focus starts on
`Cancel`.

- Good: `This deletes “Fix login” and 2 side threads. Running turns stop and their schedules are cancelled. You can undo this for a few seconds.`
- Bad: `Are you sure? This action cannot be undone and may have consequences.`

### 4.6 Loading and progress

An -ing verb plus an ellipsis: `Checking for updates…`. Show a percentage in one place
only (the bar **or** the text). Long steps say what is happening and whether it happens
only once: `Downloading PostgreSQL 17… Local mode needs this only once.`
Numbers that change live (percentages, counters, timers) use tabular digits
(`tabular-nums`) and never sit in the middle of a sentence, so the text around them
doesn't move.

### 4.7 Toasts

One short past-tense sentence about what happened (`Thread deleted`), optionally one
action (`Undo`). Errors that need a decision don't go into a toast.

### 4.8 Tooltips

For details that help but aren't needed to act. At most 2 sentences. Never the only place
for important information (touch screens often have no tooltips). An icon button's
tooltip equals its label (`Check now`).

### 4.9 Placeholders

An example of the format, not an instruction: `https://gateway.example.com`,
`my-project`. Instructions go in the label or the field description, because a
placeholder disappears as soon as the user types.

### 4.10 First run (onboarding)

One sentence on what the screen is for, then the choice. State the dependencies a
feature really needs before the choice (`Canopy downloads PostgreSQL once and sets it up
for you.`). Don't promise things another text contradicts a moment later.

## 5. Information density

- **On screen:** what the user needs to decide or act now.
- **In a tooltip or the description under a control:** how it works, the order of steps,
  exceptions.
- **In details (`Show details`):** codes, sources, raw messages, log paths.
- **In the docs:** everything else.
- A fact appears on screen once.
- **Skip minor external gaps silently.** Optional data from tools we don't control (no
  release notes for Grok, no icon, no model description): just don't show it. No
  "No release notes available".
- **Escalate serious dependencies.** Something a feature can't work without (PostgreSQL
  for local mode, a missing agent CLI, no worker for a project): say clearly what is
  needed and what to do, with an action where possible.
- Don't show empty sections, empty disclosures, or actions with nothing to do
  (`Update all` when everything is up to date).

## 6. The "soul" rule

Canopy should have a heart, not the style of 99% of apps. We get there mostly through
precision and kindness; humour is a seasoning, not the meal.

**When it's allowed:**

- an empty state people see once or rarely (for example a thread that closed without a
  single message),
- an odd, absurd edge case (searching for a bot when there are none),
- a moment of joy or relief (long work finished successfully, the first run).

**Never:**

- in errors that cost the user time, money or data,
- in destructive confirmations, security warnings or anything about secrets,
- at the user's expense (no jokes about their mistake or about them),
- in texts people see often (every day, on every screen).

**What we don't do:** puns, memes, dad jokes, worn-out IT jokes ("have you tried turning
it off and on again", "it works on my machine", "404 brain not found"), emoji instead of
words, exclamation marks, fake excitement ("Awesome!", "Woohoo!").

**How to do it:** specific (about this situation, not generic), kind (on the user's
side), short (one sentence, within the limits in §2). A sentence with soul still carries
the information: remove the "joke" and the meaning must remain.

**Frequency:** at most one such sentence per screen and only a few per feature. The audit
marks and justifies each one. When in doubt, write it plainly.

| Accepted | Rejected | Why |
|---|---|---|
| `This thread closed before anyone said a word.` | `Crickets… 🦗` | specific instead of a meme and emoji |
| `No bots yet, so nobody here answers to “{query}”.` | `404: bot not found` | worn-out IT joke |
| `Done. That took a while, but every step passed.` (long work finished successfully) | `Phew! Finally! 🎉` | exclamation marks, fake excitement |
| `Your agents, on your terms` (first run) | `Let’s get this party started!` | cliché |
| `Nothing new in that thread.` | `It’s quiet… too quiet.` | quoted cliché |
| `Could not reach the provider. Check the connection, then retry.` | `The internet ate your request 🍝` | humour in an error that costs time |
| `This deletes “Fix login”. You can undo this for a few seconds.` | `Poof! Gone forever (well, almost)` | humour in a destructive action |
| `Up to date` | `Fresher than your morning coffee` | frequent status, forced joke |

## 7. Accessibility and translation readiness

- Meaning never lives only in humour, colour or an icon. Red text has a word
  (`Update failed`), an icon button has a label, and text never points at an icon's
  shape ("the pencil above"); it names the action (`New thread`).
- No idioms or wordplay in critical texts (errors, security, data).
- Full sentences with values in variables, never glued fragments. Expect longer
  translations (+30–40%) and long user-chosen names.
- Live statuses use `role="status"`; an aria-label says the same as what is visible.

## 8. Copy audit after a feature (checklist)

Run it for every feature that changes UI text, before opening the PR. Put the result
(before → after, a short reason) in the PR description. No separate copy review is
needed.

1. Every new or changed text: one idea per sentence, length limits, active voice,
   sentence case, punctuation (§2).
2. Glossary (§3): no banned synonyms; a new term goes into the glossary.
3. Buttons and menu items start with a verb; a confirmation repeats the title's verb.
4. Every error: what happened, then what to do; details behind `Show details`; no jargon
   on the surface.
5. Empty states: a title, at most 2 sentences, at most one action.
6. No fact repeated (title, description, badge, tooltip).
7. Minor external gaps skipped; serious dependencies named with an action.
8. Sentences with "soul" marked, justified, in allowed places, at most one per screen.
9. Checked with short, typical and long names, at desktop and phone width.
10. No text relies on colour, an icon's shape or position as its only cue.
