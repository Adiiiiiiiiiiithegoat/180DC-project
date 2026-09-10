/**
 * DESIGN.md section 5, rule 7: integers in paise throughout, formatted only at
 * display. These two functions are the only places rupees exist as text.
 */

/** 12345 -> "₹123.45". Integer arithmetic only. */
export function formatPaise(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const abs = Math.abs(paise);
  const rupees = (abs - (abs % 100)) / 100;
  return `${sign}₹${rupees.toLocaleString("en-IN")}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * "80" -> 8000, "80.5" -> 8050, "80.05" -> 8005, anything else -> null.
 *
 * Parsed as a string, digit by digit, so the value never passes through a
 * float: Number("80.05") * 100 is 8004.999999999999.
 */
export function parseRupees(input: string): number | null {
  const match = /^\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(input);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/** 25000 -> "250.00", the form a price input is pre-filled with. */
export function paiseToInput(paise: number): string {
  return `${(paise - (paise % 100)) / 100}.${String(paise % 100).padStart(2, "0")}`;
}
