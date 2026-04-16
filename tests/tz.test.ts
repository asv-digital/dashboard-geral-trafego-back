import test from "node:test";
import assert from "node:assert/strict";
import {
  brtRangeFromStrings,
  dateStringBRT,
  parseBRTDateEnd,
  parseBRTDateStart,
} from "../src/lib/tz";

test("parseBRTDateStart maps BRT midnight to UTC+3", () => {
  const start = parseBRTDateStart("2026-04-14");
  assert.ok(start instanceof Date);
  assert.equal(start?.toISOString(), "2026-04-14T03:00:00.000Z");
});

test("parseBRTDateEnd maps BRT end of day to UTC next boundary minus 1ms", () => {
  const end = parseBRTDateEnd("2026-04-14");
  assert.ok(end instanceof Date);
  assert.equal(end?.toISOString(), "2026-04-15T02:59:59.999Z");
});

test("brtRangeFromStrings returns a UTC window that preserves the requested BRT dates", () => {
  const range = brtRangeFromStrings("2026-04-14", "2026-04-15");
  assert.equal(range.gte?.toISOString(), "2026-04-14T03:00:00.000Z");
  assert.equal(range.lte?.toISOString(), "2026-04-16T02:59:59.999Z");
});

test("dateStringBRT keeps late-night UTC inside the previous BRT day", () => {
  assert.equal(dateStringBRT(new Date("2026-04-15T02:30:00.000Z")), "2026-04-14");
});
