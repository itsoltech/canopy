/**
 * `work`, or what `onTimeout` gives (or throws) once `ms` pass first. The timer is cleared as soon as `work` settles:
 * a pending `Bun.sleep` in a race keeps the process alive until it fires, so a worker stopped right after listing
 * models would linger for the whole deadline.
 */
export async function withDeadline<A, B>(
  work: Promise<A>,
  ms: number,
  onTimeout: () => B | Promise<B>,
): Promise<A | B> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<B>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onTimeout());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
