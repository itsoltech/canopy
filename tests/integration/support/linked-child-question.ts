import { expect } from "bun:test";
import type { JsonValue } from "@canopy/domain";
import { qualifyId } from "@canopy/domain/computers";
import { eventually, type TestGateway } from "./gateway.ts";

export async function checkLinkedChildQuestion(
  caller: TestGateway,
  parentThread: string,
  home: TestGateway,
  child: string,
  homeNode: string,
) {
  const remote = (value: string) => qualifyId(value, homeNode);
  const tool = (name: string, args: JsonValue) => caller.worker.callTool({ threadId: parentThread, tool: name, args });
  home.worker.holdTurns = true;
  let activeTurn = "";

  try {
    const followup = await tool("send_message", {
      thread_id: remote(child),
      prompt: "Ask the owner about the next step",
    });

    expect(followup.isError).toBe(false);
    activeTurn = JSON.parse(followup.resultJson).turn_id.split("~")[0];

    const started = await eventually(
      () =>
        home.core.linkedAgents.query(
          "SELECT id FROM turns WHERE thread_id=$1::uuid AND id=$2::uuid AND status='running' AND started_at IS NOT NULL",
          [child, activeTurn],
        ),
      (rows) => rows.length === 1,
    );

    expect(started).toHaveLength(1);

    const asked = await home.worker.callTool({
      threadId: child,
      turnId: activeTurn,
      tool: "ask_user",
      args: {
        wait: false,
        questions: [
          {
            id: "choice",
            header: "Choice",
            question: "Which option?",
            kind: "single_choice",
            options: [{ label: "One" }, { label: "Two" }],
          },
        ],
      },
    });

    expect(asked.isError).toBe(false);
    const request = JSON.parse(asked.resultJson).question_set_id;
    expect(
      await eventually(
        async () => (caller.worker.inputs.get(parentThread) ?? []).some((m) => m.includes(remote(request))),
        Boolean,
      ),
    ).toBe(true);

    const answered = await tool("answer_interaction", {
      request_id: remote(request),
      response: "answer",
      answer_json: JSON.stringify({ answers: [{ id: "choice", kind: "choice", labels: ["Two"] }] }),
    });

    expect(answered.isError).toBe(false);

    const answers = await home.worker.callTool({
      threadId: child,
      turnId: activeTurn,
      tool: "get_answers",
      args: { question_set_id: request },
    });

    expect(answers.resultJson).toContain("Two");
    const summary = await tool("get_thread", { thread_id: remote(child) });
    expect(summary.resultJson).toContain(remote(child));
  } finally {
    home.worker.holdTurns = false;

    if (activeTurn) {
      home.worker.finish(child, activeTurn, "Question answered");
      await eventually(
        () =>
          home.core.linkedAgents.query(
            "SELECT id FROM turns WHERE thread_id=$1::uuid AND id=$2::uuid AND status='completed'",
            [child, activeTurn],
          ),
        (rows) => rows.length === 1,
      );
    }
  }
}
