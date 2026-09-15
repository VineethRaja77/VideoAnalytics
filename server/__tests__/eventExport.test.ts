// The CSV export, and the two ways a CSV export goes wrong.
//
//  1. FORMULA INJECTION. Excel treats a cell starting with =, +, - or @ as a
//     formula and runs it. Event details come from workers and, through the
//     face gallery, from names a client typed — so an export can carry
//     attacker-influenced text straight into a reviewer's spreadsheet. That is
//     the classic path from "we exported the incident log" to a compromised
//     machine.
//
//  2. QUOTING. A detail field containing a comma, a quote or a newline splits
//     the row and silently shifts every later column, so the export looks fine
//     and is wrong.
//
// The escaping is exercised directly here rather than through HTTP, because
// what matters is the transformation, not the plumbing around it.

import { describe, it, expect } from "vitest";

/** Mirrors the `cell()` used by /api/analytics/events.csv. */
function cell(v: unknown): string {
  let t = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
}

describe("spreadsheet formula injection", () => {
  it("defuses every character Excel treats as a formula", () => {
    for (const dangerous of [
      '=1+1',
      '=cmd|\' /C calc\'!A0',
      '+1+1',
      '-1+1',
      '@SUM(A1)',
      '\tSUM(A1)',
    ]) {
      const out = cell(dangerous);
      // The apostrophe must sit INSIDE the quotes, before the payload.
      expect(out.startsWith(`"'`), `${dangerous} was not defused: ${out}`).toBe(true);
    }
  });

  it("leaves ordinary text alone", () => {
    expect(cell("Main Gate")).toBe('"Main Gate"');
    expect(cell("Ravi Sharma")).toBe('"Ravi Sharma"');
  });

  it("defuses a person's name typed to look like a formula", () => {
    // A gallery name reaches the export through the detail column.
    expect(cell('=HYPERLINK("http://evil","click")')).toMatch(/^"'=HYPERLINK/);
  });
});

describe("quoting", () => {
  it("escapes embedded quotes by doubling them", () => {
    expect(cell('he said "stop"')).toBe('"he said ""stop"""');
  });

  it("keeps a comma inside one cell", () => {
    const row = [cell("a,b"), cell("c")].join(",");
    expect(row).toBe('"a,b","c"');
  });

  it("keeps a newline inside one cell", () => {
    expect(cell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders an empty value as an empty cell, not the word null", () => {
    expect(cell(null)).toBe('""');
    expect(cell(undefined)).toBe('""');
    expect(cell("")).toBe('""');
  });

  it("survives a whole details blob", () => {
    const details = { person: 'Ravi "Bob" Sharma', note: "a,b\nc", formula: "=1" };
    const out = cell(JSON.stringify(details));
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    // Every inner quote doubled means the row cannot break out of its cell.
    const inner = out.slice(1, -1);
    expect(inner.replace(/""/g, "")).not.toContain('"');
  });
});
