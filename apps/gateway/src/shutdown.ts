/** Slow shutdown logs identify the outstanding cleanup without exposing its input. */
export async function closeGatewayStep<A>(step: string, close: () => Promise<A> | undefined): Promise<void> {
  const started = performance.now();
  const warning = setTimeout(() => console.warn(`gateway shutdown: still waiting for ${step}`), 5_000).unref();

  try {
    await close();
  } finally {
    clearTimeout(warning);
    const elapsed = Math.round(performance.now() - started);

    if (elapsed >= 5_000) console.info(`gateway shutdown: ${step} settled after ${elapsed} ms`);
  }
}
