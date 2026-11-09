export const SECRET_KEY_PATTERN = /(authorization|(?:access|refresh|id)[_-]?token|api[_-]?key|client[_-]?secret|auth[_-]?code|password|secret)/i;

export function redactAgentSecrets(text: string): string {
  return text.replace(/\bsk-[A-Za-z0-9_-]+|Bearer\s+[^\s"'<>]+/gi, '[redacted]')
    .replace(/("?(?:api[-_ ]?key|authorization|(?:access|refresh|id)[-_ ]?token|client[-_ ]?secret|auth[-_ ]?code|password|secret)"?\s*[:=]\s*)("[^"\r\n]*"|[^\s,;}]+)/gi, '$1[redacted]');
}
