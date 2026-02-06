import {
  extractRepoFromMessage,
  guessServiceFromMessage,
  guessServiceFromName,
  parseAlertStates,
} from './utils';

describe('triage utils', () => {
  it('parses alert states', () => {
    expect(parseAlertStates('alert,warn')).toEqual(['alert', 'warn']);
    expect(parseAlertStates()).toEqual(['alert', 'warn', 'no_data']);
  });

  it('extracts repo from message', () => {
    expect(extractRepoFromMessage('Repository: capi-core').repo).toBe(
      'capi-core',
    );
    expect(extractRepoFromMessage('https://github.com/org/repo').repo).toBe(
      'repo',
    );
  });

  it('guesses service from message and name', () => {
    expect(guessServiceFromMessage('Service: capi-core')).toBe('capi-core');
    expect(guessServiceFromName('[capi-core][prd] something')).toBe(
      'capi-core',
    );
  });
});
