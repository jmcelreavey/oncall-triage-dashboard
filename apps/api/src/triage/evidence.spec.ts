import {
  extractLogsQuery,
  extractRunbookLinks,
  parseRgMatches,
  safeJsonParse,
  truncate,
} from './evidence';

describe('evidence helpers', () => {
  test('extractLogsQuery pulls datadog logs query', () => {
    const query = 'logs("service:api error:true").index("*")';
    expect(extractLogsQuery(query)).toBe('service:api error:true');
  });

  test('extractLogsQuery returns raw query when no logs() wrapper', () => {
    const query = 'service:api error:true';
    expect(extractLogsQuery(query)).toBe(query);
  });

  test('extractRunbookLinks returns only runbook links', () => {
    const message =
      'Check runbook https://example.com/runbook/foo and docs https://example.com/docs';
    expect(extractRunbookLinks(message)).toEqual([
      'https://example.com/runbook/foo',
    ]);
  });

  test('parseRgMatches parses rg output with line numbers', () => {
    const output = '/repo/config/hpa.yaml:12:minReplicas: 0';
    const hits = parseRgMatches(output, '/repo');
    expect(hits).toEqual([
      { path: 'config/hpa.yaml', line: 12, text: 'minReplicas: 0' },
    ]);
  });

  test('safeJsonParse returns fallback on invalid json', () => {
    expect(safeJsonParse('not-json', { ok: false })).toEqual({ ok: false });
  });

  test('truncate shortens large output', () => {
    const input = 'x'.repeat(15);
    const result = truncate(input, 10);
    expect(result.startsWith('xxxxxxxxxx')).toBe(true);
    expect(result).toContain('[truncated');
  });
});
