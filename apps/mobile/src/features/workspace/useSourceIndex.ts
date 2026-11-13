import { useEffect, useState } from "react";
import { SourceIndex } from "@canopy/syntax/source";
import { useAppActive } from "../../ui/active";

/** Index large previews in small foreground chunks, without per-line strings. */
export function useSourceIndex(text: string) {
  const [index, setIndex] = useState(() => new SourceIndex(text.slice(0, 8192)));
  const active = useAppActive();

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setIndex(new SourceIndex(text.slice(0, 8192)));

    const yieldWork = () =>
      new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => (cancelled ? reject(new Error("Indexing was cancelled.")) : resolve()), 0);
      });

    void SourceIndex.create(text, yieldWork)
      .then((source) => {
        if (!cancelled) setIndex(source);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, active]);

  return index.text === text || index.text === text.slice(0, 8192) ? index : new SourceIndex(text.slice(0, 8192));
}
