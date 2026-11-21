import { readFileSync } from "node:fs";

const matrix = JSON.parse(readFileSync(new URL("./supported-resolutions.json", import.meta.url)));
const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const counts = new Map(matrix.map((cell) => [cell.name, 0]));
const files = new Set();
const cases = [];

function collect(suite) {
  for (const spec of suite.specs ?? []) {
    files.add(spec.file);
    cases.push(...spec.tests);
  }
  for (const child of suite.suites ?? []) collect(child);
}

report.suites.forEach(collect);
const passing = cases.filter(({ results }) => results.length === 1 && results[0].status === "passed");
console.log("Web UI browser unit results " + JSON.stringify({
  specs: files.size,
  cases: cases.length,
  passed: passing.length,
  skipped: report.stats.skipped,
  unexpected: report.stats.unexpected,
  flaky: report.stats.flaky,
}));
for (const { results: [result] } of passing) {
  for (const att of result.attachments) {
    if (att.name !== "supported-resolution" || !att.body) continue;
    const sample = JSON.parse(Buffer.from(att.body, "base64"));
    const cell = matrix.find((entry) =>
      entry.width === sample.width && entry.height === sample.height &&
      entry.deviceScaleFactor === sample.deviceScaleFactor &&
      entry.hasTouch === sample.hasTouch && entry.colorScheme === sample.theme &&
      sample.darkMedia === (entry.colorScheme === "dark"),
    );
    if (!cell) throw new Error(`Unexpected measured resolution: ${JSON.stringify(sample)}`);
    counts.set(cell.name, counts.get(cell.name) + 1);
  }
}
for (const cell of matrix) console.log(JSON.stringify({ ...cell, passedMeasurements: counts.get(cell.name) }));
if (
  files.size !== 65 || cases.length !== 482 || passing.length !== 482 ||
  report.errors.length || [...counts.values()].some((count) => count === 0)
) {
  throw new Error("Browser qualification requires all 482 cases and six measured cells to pass");
}
