const SPREADSHEET_ID_IN_URL = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const BARE_SPREADSHEET_ID = /^[a-zA-Z0-9-_]{20,}$/;

/**
 * Accepts either a full Sheet URL or a bare spreadsheet id and returns the id.
 * Returns null when the input is not recognisable as a spreadsheet reference.
 */
export function extractSpreadsheetId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;

  const fromUrl = SPREADSHEET_ID_IN_URL.exec(value);
  if (fromUrl) return fromUrl[1];

  if (BARE_SPREADSHEET_ID.test(value)) return value;

  return null;
}

/** Converts a 1-based column index into its A1 column letter (1 -> A, 27 -> AA). */
export function toColumnLetter(columnIndex: number): string {
  let index = columnIndex;
  let letter = '';

  while (index > 0) {
    const remainder = (index - 1) % 26;
    letter = String.fromCharCode(65 + remainder) + letter;
    index = Math.floor((index - 1) / 26);
  }

  return letter;
}

/** Header cells are user-authored, so normalise before matching. */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/** Builds an absolute A1 range for a single row span. */
export function buildRowRange(
  sheetName: string,
  rowNumber: number,
  startColumnIndex: number,
  endColumnIndex: number,
): string {
  const start = toColumnLetter(startColumnIndex);
  const end = toColumnLetter(endColumnIndex);
  return `'${sheetName.replace(/'/g, "''")}'!${start}${rowNumber}:${end}${rowNumber}`;
}

/**
 * Splits a sparse set of 1-based column indexes into contiguous segments so a
 * patch can be written as minimal `update` calls without clearing the gaps.
 */
export function groupContiguousColumns(columnIndexes: number[]): Array<{
  start: number;
  end: number;
}> {
  const sorted = [...new Set(columnIndexes)].sort((a, b) => a - b);
  const segments: Array<{ start: number; end: number }> = [];

  for (const columnIndex of sorted) {
    const last = segments[segments.length - 1];

    if (last && columnIndex === last.end + 1) {
      last.end = columnIndex;
      continue;
    }

    segments.push({ start: columnIndex, end: columnIndex });
  }

  return segments;
}
