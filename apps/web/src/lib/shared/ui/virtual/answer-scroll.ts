import { tick } from "svelte";

/** Wait for the final answer and its disclosure layout before deciding whether it needs start alignment. */
export async function answerStart(
  read: () => {
    following: boolean;
    scroller: HTMLElement | undefined;
    element: HTMLElement | undefined;
    footer: number;
  },
) {
  if (!read().following) return undefined;
  await tick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const { following, scroller, element, footer } = read();

  if (
    !following ||
    !scroller ||
    !element ||
    element.getBoundingClientRect().height <= scroller.clientHeight - footer - 16
  )
    return undefined;

  return {
    element,
    scroller,
    top: scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8,
  };
}

export function moveToAnswer(scroller: HTMLElement, top: number, setTop: (top: number) => void): number {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    setTop(top);

    return 0;
  }

  scroller.scrollTo({ top, behavior: "smooth" });

  return performance.now() + 1000;
}
