import { useEffect, useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { UserAnswer } from "@canopy/domain";
import { currentAnswer } from "@canopy/domain/questions";
import { answerQuestions, mobileQuestions } from "../../../api/questions";
import { useSession } from "../../../state/session";

interface Draft {
  step: number;
  selected: Record<string, string[]>;
  texts: Record<string, string>;
  busy: boolean;
  done: boolean;
  dismissed: boolean;
  ended: boolean;
  error: string;
}

const empty: Draft = {
  step: 0,
  selected: {},
  texts: {},
  busy: false,
  done: false,
  dismissed: false,
  ended: false,
  error: "",
};

function answerError(failure: ConnectError): Pick<Draft, "ended" | "error"> {
  if (failure.code === Code.InvalidArgument && !failure.rawMessage.includes("already"))
    return { ended: false, error: "Could not send your answers. Edit them and try again." };
  const ended = failure.code === Code.FailedPrecondition || failure.rawMessage.includes("already");

  return {
    ended,
    error: ended
      ? failure.rawMessage.includes("expired")
        ? "This request expired. No answer was sent."
        : "This request is no longer pending. Check the answers in the thread."
      : "Could not confirm your answers. Check your connection and try again.",
  };
}

/** Drafts live above the single sheet: closing it, messaging and switching requests retain every step. */
export function useQuestionDraft(interaction: ui.Interaction | undefined, pendingIds: string[]) {
  const { client, online, expired } = useSession();
  const pending = pendingIds.join(",");
  const [store, setStore] = useState<{ pending: string; drafts: Record<string, Draft> }>({ pending, drafts: {} });

  if (store.pending !== pending)
    setStore({
      pending,
      drafts: Object.fromEntries(Object.entries(store.drafts).filter(([id]) => pendingIds.includes(id))),
    });
  const responses = useRef<Record<string, Record<string, UserAnswer>>>({});
  const sending = useRef(new Set<string>());
  const key = interaction?.requestId ?? "";
  const draft = store.drafts[key] ?? empty;
  const questions = interaction ? mobileQuestions(interaction) : [];
  const question = questions[draft.step];
  const labels = question ? (draft.selected[question.id] ?? []) : [];
  const text = question ? (draft.texts[question.id] ?? "") : "";
  const answer = question ? currentAnswer(question, labels, text) : undefined;
  const disabled = !client || !online || draft.busy || draft.done || draft.ended || interaction?.status !== "pending";
  useEffect(() => {
    const ids = new Set(pending.split(","));

    for (const id of Object.keys(responses.current)) if (!ids.has(id)) delete responses.current[id];
  }, [pending]);

  function patch(change: Partial<Draft>) {
    setStore((previous) =>
      !previous.pending.split(",").includes(key)
        ? previous
        : {
            ...previous,
            drafts: { ...previous.drafts, [key]: { ...(previous.drafts[key] ?? empty), ...change } },
          },
    );
  }

  function select(label: string) {
    if (!question || disabled) return;
    patch({
      selected: {
        ...draft.selected,
        [question.id]:
          question.kind === "multiple_choice"
            ? labels.includes(label)
              ? labels.filter((value) => value !== label)
              : [...labels, label]
            : [label],
      },
    });
  }

  async function finish(skipAll = false, dismissed = false) {
    if (!client || !interaction || disabled || sending.current.has(key)) return;
    sending.current.add(key);
    patch({ busy: true, error: "" });

    const answers = questions.map((q): UserAnswer =>
      skipAll ? { id: q.id, kind: "skipped" } : (responses.current[key]?.[q.id] ?? { id: q.id, kind: "skipped" }),
    );

    try {
      await answerQuestions(client.api, interaction, answers, dismissed);
      patch({ done: true, dismissed });
    } catch (failure) {
      const e = ConnectError.from(failure);

      if (e.code === Code.Unauthenticated) await expired();
      else patch(answerError(e));
    } finally {
      sending.current.delete(key);
      patch({ busy: false });
    }
  }

  async function submit(skip = false) {
    if (!question || disabled) return;
    const response: UserAnswer | undefined = skip ? { id: question.id, kind: "skipped" } : answer;

    if (!response) return;
    responses.current[key] = { ...responses.current[key], [question.id]: response };

    if (draft.step + 1 < questions.length) patch({ step: draft.step + 1 });
    else await finish();
  }

  return {
    ...draft,
    questions,
    question,
    labels,
    text,
    answer,
    select,
    setStep: (step: number) => patch({ step }),
    setText: (value: string) => question && patch({ texts: { ...draft.texts, [question.id]: value } }),
    submit,
    finish,
    disabled,
    online,
  };
}
