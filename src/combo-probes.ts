export const probeSuiteNames = ["availability-v1", "text-v1", "json-v1", "instructions-v1"] as const;
export type ProbeSuite = typeof probeSuiteNames[number];
export function probeCases(suite: ProbeSuite): Array<{ id: string; prompt: string; expected?: string; check: (content: string) => boolean }> {
  switch (suite) {
    case "availability-v1": return [{ id: "availability", prompt: "Reply exactly: OK", expected: "OK", check: (content: string) => content.trim() === "OK" }];
    case "text-v1": return [{ id: "literal-text", prompt: "Reply exactly: violet", expected: "violet", check: (content: string) => content.trim() === "violet" }];
    case "instructions-v1": return [
      { id: "ordered-output", prompt: "Return exactly these words in reverse order, separated by one space: red blue green", expected: "green blue red", check: (content: string) => content.trim() === "green blue red" },
      { id: "exclude-word", prompt: "Reply with only the number of letters in the word pear. Do not repeat the word.", expected: "4", check: (content: string) => content.trim() === "4" },
    ];
    case "json-v1": return [{ id: "json-object", prompt: 'Return only a JSON object with exactly one property named count whose numeric value is 3. No Markdown.', check: (content: string) => {
      try { const parsed: unknown = JSON.parse(content); return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.keys(parsed).length === 1 && (parsed as Record<string, unknown>).count === 3); }
      catch { return false; }
    } }];
  }
}
