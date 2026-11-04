import { app, systemPreferences } from "electron";
import { join } from "node:path";
import { macKeyRepeatTiming, type KeyRepeatTiming } from "./quit-machine.ts";

/** Electron drops EF_IS_REPEAT in CreateEventFromFlags; read it before click returns. */
export function quitKeyEvent(log: (decision: string) => void) {
  let native: { isRepeat(): boolean | undefined; timing(): KeyRepeatTiming } | undefined;

  if (process.platform === "darwin") {
    try {
      const directory = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "build");
      native = require(join(directory, "native/quit-key-event.node")) as typeof native;
      log("repeat adapter=appkit");
    } catch {
      log("cancel reason=native-repeat-adapter-unavailable");
    }
  }

  return {
    isRepeat: () => {
      try {
        return native?.isRepeat();
      } catch {
        log("cancel reason=native-repeat-event-unavailable");

        return undefined;
      }
    },
    timing: () => {
      if (process.platform !== "darwin") return { initialDelayMs: 500, intervalMs: 50 };
      let timing: KeyRepeatTiming | null = null;

      try {
        timing = macKeyRepeatTiming(
          systemPreferences.getUserDefault("InitialKeyRepeat", "integer"),
          systemPreferences.getUserDefault("KeyRepeat", "integer"),
          native?.timing(),
        );
      } catch {
        log("repeat settings-unavailable");
      }

      log(
        timing
          ? `repeat timing initialMs=${timing.initialDelayMs} intervalMs=${timing.intervalMs}`
          : "repeat disabled-or-unsupported",
      );

      return timing;
    },
  };
}
