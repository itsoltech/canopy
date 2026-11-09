import { useEffect, useRef } from "react";
import { registerUnsentWork } from "./unsent-work";

/** Hidden composers remain registered until unmount; no draft text or file metadata enters the registry. */
export function useUpdateBlocker(read: () => boolean) {
  const current = useRef(read);
  current.current = read;
  useEffect(() => registerUnsentWork(() => current.current()), []);
}
