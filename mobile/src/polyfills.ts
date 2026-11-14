import { TextDecoderStream, TextEncoderStream } from '@stardazed/streams-text-encoding';
// @ts-expect-error The package ships no types; its default export has the global structuredClone signature.
import structuredClone from '@ungap/structured-clone';

// The AI SDK streams model responses through these web APIs, which Hermes does not provide.
// Imported once, first, by the app entry; `expo/fetch` supplies the streaming response body.
const runtime: Record<string, unknown> = globalThis;
runtime.structuredClone ??= structuredClone;
runtime.TextEncoderStream ??= TextEncoderStream;
runtime.TextDecoderStream ??= TextDecoderStream;
