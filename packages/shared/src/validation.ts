export function isLoopbackHost(value: string): boolean {
  const hostname = value.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '[::1]' || hostname === '::1') return true;
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127'
    && octets.slice(1).every(octet => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255);
}

export function isLoopbackUrl(value: string): boolean {
  try { return isLoopbackHost(new URL(value).hostname); } catch { return false; }
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function isValidHttpFieldName(name: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name);
}
