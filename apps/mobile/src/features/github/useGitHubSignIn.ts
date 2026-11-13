import { useEffect, useEffectEvent, useRef, useState } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppActive } from "../../ui/active";
import { useForegroundInterval } from "../../ui/interval";

/** Persist only attempt/request identifiers, scoped to pairing and home. Tokens never leave the gateway. */
export function useGitHubSignIn(homeId: string, onconnected?: () => void) {
  const { client, session } = useSession();
  const foreground = useAppActive();
  const [attempt, setAttempt] = useState<github.GitHubDeviceAuth>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const running = useRef(false);
  const active = useRef(true);
  const current = useRef(attempt);
  const connected = useRef(onconnected);
  useEffect(() => {
    connected.current = onconnected;
  }, [onconnected]);
  const notified = useRef("");
  const key = `canopy.github.${session?.deviceId ?? "unpaired"}.${homeId.replaceAll("~", ".") || "local"}`;

  async function run(action: () => Promise<github.GitHubDeviceAuthResponse>) {
    if (running.current || !client) return;
    running.current = true;
    setBusy(true);
    setError("");

    try {
      const value = await action();

      if (!active.current) return;
      current.current = value.attempt;
      setAttempt(value.attempt);

      if (value.attempt) await SecureStore.setItemAsync(`${key}.attempt`, value.attempt.id);

      if (value.attempt?.state === "connected" && notified.current !== value.attempt.id) {
        notified.current = value.attempt.id;
        connected.current?.();
      }
    } catch {
      if (active.current) setError("Could not check GitHub sign-in. Check the connection, then retry.");
    } finally {
      running.current = false;

      if (active.current) setBusy(false);
    }
  }

  async function start() {
    await run(async () => {
      const saved = await SecureStore.getItemAsync(`${key}.request`);

      const request =
        current.current && current.current.state !== "pending" ? Crypto.randomUUID() : saved || Crypto.randomUUID();

      await SecureStore.setItemAsync(`${key}.request`, request);

      // SAFETY: run invokes actions only with the paired client captured by this render.
      return client!.api.beginGitHubDeviceAuth({ homeId, clientRequestId: request });
    });
  }

  const poll = () => {
    const id = current.current?.id;

    // SAFETY: run guards the paired client before invoking the deferred action.
    if (id && current.current?.state === "pending" && AppState.currentState === "active")
      void run(() => client!.api.getGitHubDeviceAuth({ attemptId: id }));
  };

  useForegroundInterval(poll, 2000, attempt?.state === "pending");
  const resume = useEffectEvent(poll);
  useEffect(() => {
    if (foreground) resume();
  }, [foreground]);

  useEffect(() => {
    active.current = true;
    void SecureStore.getItemAsync(`${key}.attempt`)
      .then((id) => {
        // SAFETY: run guards the paired client; the mounted flow owns this saved attempt identifier.
        if (id && active.current) void run(() => client!.api.getGitHubDeviceAuth({ attemptId: id }));
      })
      .catch(() => {
        if (active.current) setError("Could not restore GitHub sign-in. Start again to get a new code.");
      });

    return () => {
      active.current = false;
    };
    // The parent keys this flow by home and pairing; a render must never start a second poller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);

  return {
    attempt,
    busy,
    error,
    start,
    retry: poll,
    // SAFETY: the UI exposes Cancel only for a pending attempt; run also guards the paired client.
    cancel: () => run(() => client!.api.cancelGitHubDeviceAuth({ attemptId: current.current!.id })),
  };
}
