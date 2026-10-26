import { z } from 'zod';
import { defaultSettings, mobileSettingsSchema, type MobileSettings } from './settings';

const metadataKey = 'shuddhalekhan.settings';
const secretPrefix = 'shuddhalekhan.settings';

const serverSettingsSchema = mobileSettingsSchema.shape.mcpServers.element
  .omit({ token: true })
  .extend({ tokenRef: z.string().min(1).nullable() })
  .strict();

const storedSettingsSchema = z.object(mobileSettingsSchema.shape).omit({
  transcriptionKey: true, agentKey: true, googleServiceAccount: true, mcpServers: true,
}).extend({
  mcpServers: z.array(serverSettingsSchema).max(10),
  transcriptionKeyRef: z.string().min(1).nullable(),
  agentKeyRef: z.string().min(1).nullable(),
  googleServiceAccountRef: z.string().min(1).nullable().default(null),
}).strict();

const envelopeSchema = z.object({
  version: z.literal(1),
  generation: z.string().regex(/^[a-z0-9-]{1,80}$/),
  settings: storedSettingsSchema,
}).strict();

type Envelope = z.infer<typeof envelopeSchema>;

type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type SecretStorage = KeyValueStorage & {
  deleteItem(key: string): Promise<void>;
};

type SettingsStoreOptions = {
  metadata: KeyValueStorage;
  secrets: SecretStorage;
  createId(): string;
};

function secretKey(generation: string, name: string): string {
  return `${secretPrefix}.${generation}.${name}`;
}

function readEnvelope(raw: string): Envelope | null {
  try {
    const decoded: unknown = JSON.parse(raw);
    const envelope = envelopeSchema.parse(decoded);
    const refs = [
      [envelope.settings.transcriptionKeyRef, secretKey(envelope.generation, 'transcription')],
      [envelope.settings.agentKeyRef, secretKey(envelope.generation, 'agent')],
      [envelope.settings.googleServiceAccountRef, secretKey(envelope.generation, 'google')],
      ...envelope.settings.mcpServers.map((server, index) => [server.tokenRef, secretKey(envelope.generation, `mcp-${index}`)]),
    ];
    if (refs.some(([ref, expected]) => ref !== null && ref !== expected)) return null;
    return envelope;
  } catch {
    return null;
  }
}

function referencedSecrets(envelope: Envelope): string[] {
  return [
    envelope.settings.transcriptionKeyRef,
    envelope.settings.agentKeyRef,
    envelope.settings.googleServiceAccountRef,
    ...envelope.settings.mcpServers.map(server => server.tokenRef),
  ].filter((ref): ref is string => ref !== null);
}

export function createSettingsStore({ metadata, secrets, createId }: SettingsStoreOptions) {
  async function loadSettings(): Promise<MobileSettings> {
    let raw: string | null;
    try {
      raw = await metadata.getItem(metadataKey);
    } catch {
      throw new Error('Could not read saved settings.');
    }
    if (raw === null) return mobileSettingsSchema.parse(defaultSettings);

    const envelope = readEnvelope(raw);
    if (!envelope) throw new Error('Saved settings are corrupt or invalid.');

    try {
      const loadSecret = async (ref: string | null) => {
        if (ref === null) return '';
        const value = await secrets.getItem(ref);
        if (value === null) throw new Error();
        return value;
      };
      const [transcriptionKey, agentKey, googleServiceAccount, ...serverTokens] = await Promise.all([
        loadSecret(envelope.settings.transcriptionKeyRef),
        loadSecret(envelope.settings.agentKeyRef),
        loadSecret(envelope.settings.googleServiceAccountRef),
        ...envelope.settings.mcpServers.map(server => loadSecret(server.tokenRef)),
      ]);
      return mobileSettingsSchema.parse({
        ...envelope.settings,
        transcriptionKey,
        agentKey,
        googleServiceAccount,
        mcpServers: envelope.settings.mcpServers.map((server, index) => ({
          id: server.id,
          name: server.name,
          endpoint: server.endpoint,
          enabled: server.enabled,
          token: serverTokens[index] ?? '',
        })),
      });
    } catch {
      throw new Error('Could not load saved settings. Check device secure storage.');
    }
  }

  async function saveSettings(settings: MobileSettings): Promise<MobileSettings> {
    const parsed = mobileSettingsSchema.safeParse(settings);
    if (!parsed.success) throw new Error('Settings are invalid.');

    let previousRaw: string | null;
    try {
      previousRaw = await metadata.getItem(metadataKey);
    } catch {
      throw new Error('Could not read saved settings before saving.');
    }
    const previous = previousRaw === null ? null : readEnvelope(previousRaw);
    const generation = createId();
    if (!/^[a-z0-9-]{1,80}$/.test(generation) || previous?.generation === generation) {
      throw new Error('Could not create a settings storage generation.');
    }

    const staged: string[] = [];
    const storeSecret = async (name: string, value: string): Promise<string | null> => {
      if (value === '') return null;
      const key = secretKey(generation, name);
      staged.push(key);
      await secrets.setItem(key, value);
      return key;
    };

    try {
      const transcriptionKeyRef = await storeSecret('transcription', parsed.data.transcriptionKey);
      const agentKeyRef = await storeSecret('agent', parsed.data.agentKey);
      const googleServiceAccountRef = await storeSecret('google', parsed.data.googleServiceAccount);
      const mcpServers = [];
      for (const [index, server] of parsed.data.mcpServers.entries()) {
        mcpServers.push({
          id: server.id,
          name: server.name,
          endpoint: server.endpoint,
          enabled: server.enabled,
          tokenRef: await storeSecret(`mcp-${index}`, server.token),
        });
      }
      const { transcriptionKey: _transcriptionKey, agentKey: _agentKey, googleServiceAccount: _googleServiceAccount, mcpServers: _servers, ...publicSettings } = parsed.data;
      const envelope: Envelope = {
        version: 1,
        generation,
        settings: {
          ...publicSettings,
          transcriptionKeyRef,
          agentKeyRef,
          googleServiceAccountRef,
          mcpServers,
        },
      };
      await metadata.setItem(metadataKey, JSON.stringify(envelope));
    } catch {
      await Promise.all(staged.map(async key => {
        try { await secrets.deleteItem(key); } catch { /* An orphaned staged key must not hide the save failure. */ }
      }));
      throw new Error('Could not save settings securely. Existing settings were kept.');
    }

    if (previous) {
      const committed = new Set(staged);
      await Promise.all(referencedSecrets(previous).filter(key => !committed.has(key)).map(async key => {
        try { await secrets.deleteItem(key); } catch { /* Keep the successfully committed generation usable. */ }
      }));
    }
    return parsed.data;
  }

  return { loadSettings, saveSettings };
}
