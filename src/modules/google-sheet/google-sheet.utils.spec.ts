import {
  buildRowRange,
  extractSpreadsheetId,
  groupContiguousColumns,
  normalizeHeader,
  toColumnLetter,
} from './google-sheet.utils';

describe('extractSpreadsheetId', () => {
  it('extracts the id from an edit URL', () => {
    const id = extractSpreadsheetId(
      'https://docs.google.com/spreadsheets/d/1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I/edit#gid=0',
    );

    expect(id).toBe('1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I');
  });

  it('accepts a bare spreadsheet id', () => {
    expect(
      extractSpreadsheetId('1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I'),
    ).toBe('1X8K4-PVh_iKxqCKG5t4sDr4iiFg1cTKnb1cmnI_fb6I');
  });

  it('rejects values that are not spreadsheet references', () => {
    expect(extractSpreadsheetId('not-a-sheet')).toBeNull();
    expect(extractSpreadsheetId('https://example.com/sheets')).toBeNull();
    expect(extractSpreadsheetId('   ')).toBeNull();
  });
});

describe('toColumnLetter', () => {
  it.each([
    [1, 'A'],
    [5, 'E'],
    [16, 'P'],
    [17, 'Q'],
    [26, 'Z'],
    [27, 'AA'],
  ])('maps column %i to %s', (index, expected) => {
    expect(toColumnLetter(index)).toBe(expected);
  });
});

describe('normalizeHeader', () => {
  it('normalises user-authored header casing and separators', () => {
    expect(normalizeHeader(' Follow Up Days ')).toBe('follow_up_days');
    expect(normalizeHeader('follow-up-status')).toBe('follow_up_status');
  });
});

describe('buildRowRange', () => {
  it('builds a quoted single-row range', () => {
    expect(buildRowRange('Candidates', 7, 5, 6)).toBe("'Candidates'!E7:F7");
  });

  it('escapes quotes in the tab name', () => {
    expect(buildRowRange("Bob's list", 2, 1, 1)).toBe("'Bob''s list'!A2:A2");
  });
});

describe('groupContiguousColumns', () => {
  it('groups adjacent columns and leaves gaps untouched', () => {
    expect(groupContiguousColumns([5, 6, 1, 3])).toEqual([
      { start: 1, end: 1 },
      { start: 3, end: 3 },
      { start: 5, end: 6 },
    ]);
  });

  it('deduplicates and sorts', () => {
    expect(groupContiguousColumns([4, 4, 5])).toEqual([{ start: 4, end: 5 }]);
  });

  it('returns no segments for an empty patch', () => {
    expect(groupContiguousColumns([])).toEqual([]);
  });
});
