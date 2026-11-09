import { useEffect, useRef } from "react";
import { useDevicePreferences } from "./device-preferences";

/** Route changes expand the archive; sidebar remounts and subsequent manual collapse do not. */
export function useArchivedThreadDisclosure(archivedId: string | undefined) {
  const device = useDevicePreferences();
  const opened = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!device.viewLoaded) return;

    if (archivedId && archivedId !== opened.current) device.setView({ archivedThreadsExpanded: true });
    opened.current = archivedId;
  }, [archivedId, device]);
}
