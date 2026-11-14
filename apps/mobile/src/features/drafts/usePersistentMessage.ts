import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useIsFocused } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { composerTargetKey } from "@canopy/domain/composer-drafts";
import { useSession } from "../../state/session";
import { useMessageDraft } from "../composer/useMessageDraft";
import { MobileComposerState } from "./store";
import { ComposerLocalStore } from "@canopy/domain/composer-drafts";
import * as Crypto from "expo-crypto";

const empty = new ComposerLocalStore(
  () => {},
  () => Crypto.randomUUID(),
);

export function usePersistentMessage(target: ui.ComposerDraftTarget, visible = true) {
  const { drafts, client } = useSession();
  const focused = useIsFocused();
  const key = composerTargetKey(target);

  const state = useMemo(
    () =>
      drafts?.get(target) ??
      new MobileComposerState(
        create(ui.LocalComposerDraftSchema, {
          draft: { id: Crypto.randomUUID(), target, content: { clientRequestId: Crypto.randomUUID() } },
        }),
        empty,
      ),
    [drafts, key],
  );

  useSyncExternalStore(state.subscribe, state.snapshot);
  useEffect(() => {
    if (client && focused && visible) void state.reconcile(client.api);
  }, [state, client, focused, visible]);

  const message = useMessageDraft({
    value: state.value,
    files: state.files,
    onChange: state.persist,
    keepAlive: true,
    persistent: state,
  });

  useEffect(() => {
    const save = () => {
      state.persist();
      void drafts?.flush();

      if (client) void state.publish(client.api).catch(() => {});
    };

    if (!focused || !visible) save();

    const listener = AppState.addEventListener("change", (next) => {
      if (next !== "active") save();
    });

    return () => {
      listener.remove();
      save();
    };
  }, [state, client, focused, visible, drafts]);

  return message;
}
