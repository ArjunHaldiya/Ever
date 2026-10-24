/**
 * Local PII redaction (FR-7). Regex only: catches phone numbers, emails, SSNs,
 * card-like numbers and street addresses. It cannot catch names; in AWS the
 * worker runs Amazon Comprehend DetectPiiEntities first and uses this as the
 * offline / degraded fallback. Over-redaction is the safe direction.
 * ZIP codes are kept (the Needs row stores the ZIP anyway).
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "[EMAIL]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"],
  [/\b(?:\d[ -]?){13,16}\b/g, "[CARD]"],
  [/(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g, "[PHONE]"],
  [
    /\b\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,4}(?:st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway)\b\.?/gi,
    "[ADDRESS]",
  ],
];

export function redactPii(text: string): string {
  return REDACTIONS.reduce((acc, [re, label]) => acc.replace(re, label), text);
}
