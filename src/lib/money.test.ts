import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPaise, parseRupees } from "./money";

test("parseRupees turns typed rupees into exact paise, never via a float", () => {
  assert.equal(parseRupees("80"), 8000);
  assert.equal(parseRupees("80.5"), 8050);
  assert.equal(parseRupees("80.05"), 8005); // Number("80.05") * 100 === 8004.999...
  assert.equal(parseRupees(" 1234.99 "), 123499);
  assert.equal(parseRupees("0"), 0);
  for (const bad of ["", "abc", "-5", "80.123", "1e3", "8,000", "80."]) {
    assert.equal(parseRupees(bad), null, `"${bad}" must be rejected`);
  }
});

test("formatPaise renders Indian grouping without touching the stored integer", () => {
  assert.equal(formatPaise(8005), "₹80.05");
  assert.equal(formatPaise(12345678), "₹1,23,456.78");
  assert.equal(formatPaise(0), "₹0.00");
  assert.equal(formatPaise(-2500), "-₹25.00");
});
