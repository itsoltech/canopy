/** Synthetic credentials shared by security tests at every import boundary. */
export const URL_BOUNDARIES = [
  ...[" ", '"', "'", "`", "\u00a0", "\u2003", "%20", '"\n', '"\r\n', "`\n\n"].map(
    (separator) => `https://deploy:prefix${separator}CANARY-0042@example.test/repo`,
  ),
  'https://deploy:prefix"CANARY-0042\nnext line',
  "https://example.test:CANARY-0042",
  "https://invalid^CANARY-0042",
  ...[" ", '"', "'", "`", "\n", "\r\n"].flatMap((separator) => [
    `https://example.test/?token=prefix${separator}CANARY-0042`,
    `https://example.test/?token=prefix${separator}CANARY-0042&design=compact#authentication`,
  ]),
  ...["typescript", "TypeScript", "README.md", "src/Main.ts", "code-quality", "200", "a.b", "CANARY.0042"].map(
    (value) => `https://example.test/?code=${value}`,
  ),
];

export const READABLE_URL_PROSE = "See https://docs.example.test (contact ops@example.test).";
