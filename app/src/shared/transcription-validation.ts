import { hasControlCharacters, isLoopbackHost } from '@shuddhalekhan/shared/validation';

export function validateOpenAiModel(model: string): string[] {
  const trimmed = model.trim();
  if (!trimmed) return ['Enter a model name.'];
  if (trimmed.length > 128) return ['Model name is too long (max 128 characters).'];
  if (hasControlCharacters(trimmed)) return ['Model name contains control characters.'];
  return [];
}

export function validateAzureSpeechSettings(settings: { endpoint: string; region: string }): string[] {
  const endpoint = settings.endpoint.trim();
  const region = settings.region.trim();
  if (!endpoint && !region) {
    return ['Enter a Microsoft Azure Speech resource endpoint or region.'];
  }

  const errors: string[] = [];
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== 'https:') errors.push('Azure resource endpoint must use HTTPS.');
    } catch {
      errors.push('Enter a valid Azure resource endpoint URL.');
    }
  }
  if (region && !/^[a-z0-9-]{2,64}$/i.test(region)) {
    errors.push('Azure region may contain only letters, numbers, and hyphens.');
  }
  return errors;
}

export function validateGoogleProject(value: string): string | null {
  return /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.trim()) ? null : 'Enter a valid Google Cloud project ID.';
}

export function validateGoogleLocation(value: string): string | null {
  return /^[a-z0-9-]{1,63}$/.test(value.trim()) ? null : 'Enter a valid Google Cloud location.';
}

export function validateGoogleCloudSpeechSettings(settings: { project: string; location: string; model: string }): string[] {
  return [
    validateGoogleProject(settings.project),
    validateGoogleLocation(settings.location),
    ...validateOpenAiModel(settings.model),
  ].filter((error): error is string => error !== null);
}

export function validateNvidiaSpeechNimSettings(settings: { endpoint: string; model: string; auth: string; headerName?: string }): string[] {
  return validateCustomOpenAiSettings(settings);
}

export function validateCustomOpenAiSettings(settings: { endpoint: string; model: string; auth: string; headerName?: string }): string[] {
  const errors: string[] = [];
  try {
    const url = new URL(settings.endpoint);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push('Endpoint must use HTTP or HTTPS.');
    }
  } catch {
    errors.push('Enter a valid endpoint URL.');
  }
  if (settings.auth === 'header' && !settings.headerName?.trim()) {
    errors.push('Header name is required when auth is set to Header.');
  }
  errors.push(...validateOpenAiModel(settings.model));
  return errors;
}

export function validateWhisperLiveKitSettings(settings: {
  baseUrl: string;
  auth: string;
}): string[] {
  const value = settings.baseUrl.trim();
  if (!value) return ['WhisperLiveKit base URL is required.'];

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return ['Enter a valid WhisperLiveKit base URL.'];
  }

  if (parsed.username || parsed.password) {
    return ['WhisperLiveKit endpoint URLs cannot contain credentials.'];
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return ['WhisperLiveKit endpoints must use HTTP or HTTPS.'];
  }

  const hostname = parsed.hostname.toLowerCase();
  const loopback = isLoopbackHost(hostname);
  if (parsed.protocol === 'http:' && !loopback) {
    return ['Remote WhisperLiveKit endpoints must use HTTPS.'];
  }
  if (settings.auth !== 'none' && settings.auth !== 'bearer') {
    return ['WhisperLiveKit authentication mode is invalid.'];
  }

  return [];
}

export function validateLocalWhisperSettings(settings: { endpoint: string }): string[] {
  let url: URL;
  try {
    url = new URL(settings.endpoint);
  } catch {
    return ['Enter a valid endpoint URL.'];
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
    ? []
    : ['Endpoint must use HTTP or HTTPS.'];
}
