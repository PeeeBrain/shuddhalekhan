import { expect, it } from 'bun:test';
import { providerDiagnostic } from '../provider-diagnostic';

for (const [code, statusCode, message, action] of [
  ['subscription_sharing_user_not_eligible', 403, 'eligible', 'ChatGPT'],
  ['subscription_sharing_usage_limit_exceeded', 429, 'usage limit', 'https://chatgpt.com/settings/usage'],
  ['subscription_sharing_usage_unavailable', 503, 'unavailable', 'Try again'],
  ['subscription_sharing_unsupported_capability', 400, 'capability', 'settings'],
  ['subscription_sharing_route_not_supported', 403, 'route', 'Responses'],
  ['subscription_sharing_invalid_user', 401, 'account', 'Sign in'],
  ['chatpass_v2_scope_not_authorized', 403, 'plan usage', 'Sign in'],
  ['chatpass_v2_invalid_authorization_context', 403, 'plan usage', 'Sign in'],
  ['subscription_sharing_user_unavailable', 503, 'unavailable', 'Try again'],
] as const) {
  it(`explains plan error ${code} without suggesting a different billing path`, () => {
    const diagnostic = providerDiagnostic({ statusCode, responseBody: JSON.stringify({ detail: code }) });
    expect(diagnostic.message).toContain(message);
    expect(diagnostic.action).toContain(action);
    expect(diagnostic.action).not.toMatch(/API key|billing|credit|reset|Replace the key/);
  });
}

it('recognizes a mid-stream plan error code and removes token fields from technical details', () => {
  const diagnostic = providerDiagnostic({ code: 'subscription_sharing_usage_limit_exceeded', message: 'Limit reached',
    data: { refresh_token: 'private-refresh', id_token: 'private-identity', access_token: 'private-access' } });
  expect(diagnostic.action).toContain('https://chatgpt.com/settings/usage');
  expect(diagnostic.details).not.toMatch(/private-/);
});
