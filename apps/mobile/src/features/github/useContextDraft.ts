import { useCallback, useRef } from "react";
import { useFocusEffect } from "expo-router";
import type { MessageDraft } from "../composer/useMessageDraft";
import { takeContext } from "./context-draft";

export function useContextDraft(id: string, message: MessageDraft, onError: (message: string) => void) {
  const latest = useRef({ message, onError });
  latest.current = { message, onError };
  useFocusEffect(
    useCallback(() => {
      const context = takeContext(id);

      if (!context?.attachment) return;
      const draft = latest.current.message;

      try {
        draft.files.accept(context.attachment, context.scope);

        if (context.prompt) draft.appendText(context.prompt);
      } catch {
        latest.current.onError("Could not add PR context. Remove an attachment, then retry.");
      }
    }, [id]),
  );
}
