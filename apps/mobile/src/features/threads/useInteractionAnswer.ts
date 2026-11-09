import { useRef, useState } from "react";
import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";

type Response = Pick<ui.AnswerInteractionRequest, "allow" | "allowForSession" | "message" | "answerJson" | "cancelled">;

export function useInteractionAnswer(interaction: ui.Interaction) {
  const { client, online, expired } = useSession();
  const sending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [ended, setEnded] = useState(false);
  const [error, setError] = useState("");
  const disabled = !client || !online || busy || done || ended || interaction.status !== "pending";

  async function respond(response: Partial<Response>) {
    if (!client || disabled || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");

    try {
      await client.api.answerInteraction({ requestId: interaction.requestId, ...response }, { timeoutMs: 20_000 });
      setDone(true);
    } catch (failure) {
      const e = ConnectError.from(failure);

      if (e.code === Code.Unauthenticated) await expired();
      else if (e.code === Code.FailedPrecondition || e.code === Code.NotFound) {
        setEnded(true);
        setError(
          e.rawMessage.includes("expired")
            ? "This request expired. No response was sent."
            : "This request is no longer pending. Check the thread for details.",
        );
      } else setError("Could not confirm your response. Check the connection and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return { busy, done, ended, error, disabled, online, respond };
}
