export function isDeepSeekV4Provider(baseUrl: string, model: string): boolean {
  try {
    const url = new URL(baseUrl);
    return (url.hostname === 'api.deepseek.com'
      || (url.hostname === 'opencode.ai' && url.pathname.startsWith('/zen/')))
      && (model === 'deepseek-v4-flash' || model === 'deepseek-v4-pro');
  } catch {
    return false;
  }
}


export const OPENROUTER_HEADERS = {
  'HTTP-Referer': 'https://github.com/parthashirolkar/shuddhalekhan',
  'X-OpenRouter-Title': 'Shuddhalekhan',
};

export function isChatGptIncludeRejection(param: string): boolean {
  return /^include(?:\[|\.|$)/.test(param);
}
