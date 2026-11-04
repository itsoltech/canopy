import { create } from "@bufbuild/protobuf";
import { InteractionKind, ui, type Item } from "@canopy/contracts";
import { busControlItems, busThreadItems } from "./bus-tool-fixtures.ts";
import { claudeToolItems, codexToolItems } from "./harness-tool-fixtures.ts";
import { GALLERY_THREAD_ID, item, OTHER, SIDE } from "./tool-fixture-kit.ts";

/**
 * Tool calls of every kind the timeline knows, with made-up but realistic inputs and results (shapes taken
 * from real Claude Code, Codex and agent bus transcripts), for the dev gallery (`/dev/tool-calls`).
 */
export function toolGallery(): { title: string; items: Item[] }[] {
  return [
    { title: "Claude Code", items: claudeToolItems() },
    { title: "Codex", items: codexToolItems() },
    { title: "Agent bus", items: [...busThreadItems(), ...busControlItems()] },
    {
      title: "Interactions and provider events",
      items: [
        item("perm", {
          case: "interactionPrompt",
          value: {
            requestId: "r",
            kind: InteractionKind.PERMISSION,
            toolName: "shell",
            requestJson: JSON.stringify({ command: "rm -rf build", cwd: "/repo", reason: "Clean the old build." }),
            responseJson: JSON.stringify({ allow: true }),
            outcome: "allowed",
          },
        }),
        item("question", {
          case: "interactionPrompt",
          value: {
            requestId: "q",
            kind: InteractionKind.QUESTION,
            toolName: "request_user_input",
            requestJson: JSON.stringify({
              questions: [
                {
                  id: "env",
                  header: "Target",
                  question: "Which environment should I deploy to?",
                  options: [{ label: "Staging" }, { label: "Production" }],
                },
              ],
            }),
            responseJson: JSON.stringify({ answers: { env: { answers: ["Staging"] } } }),
            outcome: "answered",
          },
        }),
        item("provider", {
          case: "providerItem",
          value: {
            type: "enteredReviewMode",
            json: JSON.stringify({
              type: "enteredReviewMode",
              id: "item_7f3a9c0d4e5b6a7f8091",
              review: "Review the changes on this branch",
              target: { type: "baseBranch", branch: "main" },
            }),
          },
        }),
      ],
    },
  ];
}

/** Threads the gallery's links name, so they show titles and live status. */
export function galleryThreads(): ui.Thread[] {
  return [
    create(ui.ThreadSchema, { id: SIDE, title: "Lister", status: "running" }),
    create(ui.ThreadSchema, { id: OTHER, title: "Hej", status: "idle" }),
    create(ui.ThreadSchema, { id: GALLERY_THREAD_ID, title: "Tool calls gallery", status: "idle" }),
  ];
}
