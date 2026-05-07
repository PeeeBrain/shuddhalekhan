import { describe, expect, it } from 'bun:test';
import { sanitizeAuditPayload } from '../audit';

describe('sanitizeAuditPayload', () => {
  it('redacts secret-looking keys and bearer values', () => {
    expect(
      sanitizeAuditPayload({
        Authorization: 'Bearer abc.def',
        nested: {
          refresh_token: 'token',
          text: 'use sk-test-value here',
        },
      })
    ).toEqual({
      Authorization: '[redacted]',
      nested: {
        refresh_token: '[redacted]',
        text: 'use [redacted] here',
      },
    });
  });
});
