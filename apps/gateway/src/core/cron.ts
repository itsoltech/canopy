/**
 * Cron for platform schedules (docs/agent-bus.md#5-harmonogram): five fields, an IANA time zone,
 * evaluated with Bun's parser (DST-aware). Pure functions; the scheduler stores the next run.
 */

/** Next run strictly after `after`, or undefined when the expression has no future runs. */
export function nextCronRun(cron: string, timezone: string, after: Date): Date | undefined {
  const next = Bun.cron.parse(cron, after, { tz: timezone });

  return next ? new Date(next) : undefined;
}

/**
 * Why a recurring schedule is not acceptable, or undefined. Checks the real gaps between upcoming
 * runs (not just the minute field), so `0,1,2 * * * *` is refused like `* * * * *`.
 */
export function cronProblem(cron: string, timezone: string, minMinutes: number, now: Date): string | undefined {
  if (cron.trim().split(/\s+/).length !== 5) return "cron must have five fields";
  let previous: Date | undefined;

  try {
    let at = now;

    for (let i = 0; i < 48; i++) {
      const next = nextCronRun(cron, timezone, at);

      if (!next) return i === 0 ? "cron has no future runs" : undefined;

      if (previous && next.getTime() - previous.getTime() < minMinutes * 60_000) {
        return `cron runs more often than every ${minMinutes} minutes`;
      }

      previous = next;
      at = next;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  return undefined;
}
