import { formatLogEvent } from './log-event.util';

describe('formatLogEvent', () => {
  it('always leads with the event name so lines can be filtered on it', () => {
    expect(formatLogEvent('candidate.sent', { row: 4 })).toBe(
      'event=candidate.sent row=4',
    );
  });

  it('omits null and undefined fields instead of printing them', () => {
    expect(
      formatLogEvent('candidate.sent', {
        row: 4,
        role: undefined,
        campaignId: null,
      }),
    ).toBe('event=candidate.sent row=4');
  });

  it('quotes values containing whitespace so the line stays parseable', () => {
    expect(
      formatLogEvent('candidate.failed', {
        reason: '550 mailbox not found',
      }),
    ).toBe('event=candidate.failed reason="550 mailbox not found"');
  });

  it('escapes embedded quotes', () => {
    expect(formatLogEvent('e', { note: 'say "hi"' })).toBe(
      'event=e note="say \\"hi\\""',
    );
  });

  it('handles an empty field set', () => {
    expect(formatLogEvent('batch.empty')).toBe('event=batch.empty');
  });
});
