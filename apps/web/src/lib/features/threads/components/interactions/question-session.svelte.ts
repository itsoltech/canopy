import type { ui } from "@canopy/contracts";
import type { UserAnswer } from "@canopy/domain";
import { answerInteraction } from "../../api.ts";
import { currentAnswer, encodeAnswers, parseQuestions } from "./questions.ts";

/** Drafts belong to the set, so Back, collapse and messaging never discard an answer. */
export class QuestionSession {
  readonly interaction: ui.Interaction;
  readonly questions;
  step = $state(0);
  selected = $state<Record<string, string[]>>({});
  texts = $state<Record<string, string>>({});
  responses = $state<Record<string, UserAnswer>>({});
  collapsed = $state(false);
  messaging = $state(false);
  busy = $state(false);
  done = $state(false);
  error = $state("");
  constructor(interaction: ui.Interaction) {
    this.interaction = interaction;
    this.questions = parseQuestions(interaction.requestJson);
  }
  get question() {
    return this.questions[this.step]!;
  }
  get text() {
    return this.texts[this.question.id] ?? "";
  }
  set text(text: string) {
    this.texts[this.question.id] = text;
  }
  get labels() {
    return this.selected[this.question.id] ?? [];
  }
  get answer() {
    return currentAnswer(this.question, this.labels, this.text);
  }
  select(label: string) {
    const q = this.question;
    this.selected[q.id] =
      q.kind === "multiple_choice"
        ? this.labels.includes(label)
          ? this.labels.filter((l) => l !== label)
          : [...this.labels, label]
        : [label];
  }
  async submit(skip = false) {
    if (this.busy) return;
    const answer = skip ? { id: this.question.id, kind: "skipped" as const } : this.answer;

    if (!answer) return;
    this.responses[answer.id] = answer;

    if (this.step < this.questions.length - 1) this.step++;
    else await this.finish();
  }
  async finish(skipAll = false, dismissed = false) {
    if (this.busy) return;

    const answers = this.questions.map((q): UserAnswer =>
      skipAll ? { id: q.id, kind: "skipped" } : (this.responses[q.id] ?? { id: q.id, kind: "skipped" }),
    );

    this.busy = true;
    this.error = "";

    try {
      await answerInteraction(
        this.interaction.requestId,
        dismissed
          ? { cancelled: true }
          : { answerJson: encodeAnswers(this.interaction.toolName, this.questions, answers) },
      );
      this.done = true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
}
