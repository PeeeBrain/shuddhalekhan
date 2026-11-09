import { expect, it } from 'bun:test';
import { isLocalProviderUrl } from '../settings-model';

it('IPv6 loopback providers are classified as local', () => {
  expect(isLocalProviderUrl('http://[::1]:11434/v1')).toBe(true);
});
