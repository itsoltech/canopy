import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { AppUpdateHistory } from "@canopy/domain/release/app-history";
import { aggregateNotes } from "@canopy/domain/release/note-range";
import { fetchReleaseNotes, recentNotes, type NotesIndex } from "@canopy/domain/release/notes";
import { loadDeviceView, saveDeviceView } from "../../storage/device-view";
import { CANOPY_VERSION } from "../../version";

/** The bundled JS version changes after OTA and store updates. History belongs to the install, not pairing. */
function useWhatsNewState() {
  const [previous, setPrevious] = useState("");
  const [notice, setNotice] = useState(false);
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState(true);
  const [index, setIndex] = useState<NotesIndex>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setPending(true);
    setError("");

    try {
      setIndex(await fetchReleaseNotes());
    } catch {
      setError("Could not load release notes. Retry or view releases on GitHub.");
    } finally {
      setPending(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let writes = Promise.resolve();
    const scope = "updates.mobile";

    const history = new AppUpdateHistory((raw) => {
      writes = writes
        .then(() => saveDeviceView(scope, raw))
        .catch(() => {
          // Advisory history must not interrupt startup. This launch keeps the baseline in memory.
        });
    });

    void loadDeviceView(scope)
      .catch(() => null)
      .then((raw) => {
        if (!active) return;
        history.load(raw);
        const updated = history.observe(CANOPY_VERSION);
        setPrevious(history.range?.from ?? "");
        setRecent(!history.range);
        setNotice(updated);

        if (updated) void load();
      });

    return () => {
      active = false;
    };
  }, [load]);

  return {
    previous,
    notice,
    dismiss: () => setNotice(false),
    open,
    close: () => setOpen(false),
    recent,
    setRecent,
    index,
    pending,
    error,
    load,
    range: index && previous ? aggregateNotes(index, previous, CANOPY_VERSION) : undefined,
    releases: index ? recentNotes(index, CANOPY_VERSION) : [],
    show() {
      setNotice(false);
      setRecent(!previous);
      setOpen(true);

      if (!index && !pending) void load();
    },
  };
}

const Context = createContext<ReturnType<typeof useWhatsNewState> | null>(null);

export function WhatsNewProvider({ children }: { children: ReactNode }) {
  return <Context.Provider value={useWhatsNewState()}>{children}</Context.Provider>;
}

export function useWhatsNew() {
  const value = useContext(Context);

  if (!value) throw new Error("Missing WhatsNewProvider");

  return value;
}
