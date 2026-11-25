// Month and day in the client's local calendar, encoded as MMDD.
// Start is inclusive and end is exclusive. The first matching accent wins.
const accents = [{ id: "snow", start: 1201, end: 107 }] as const;

export type SeasonalAccent = (typeof accents)[number]["id"];

export function seasonalAccentFor(date: Date): SeasonalAccent | null {
  const day = (date.getMonth() + 1) * 100 + date.getDate();

  return (
    accents.find(({ start, end }) => (start <= end ? day >= start && day < end : day >= start || day < end))?.id ?? null
  );
}
