import { z } from 'zod';
import { defaultSettings, mobileSettingsSchema, type MobileSettings } from './settings';
import { secretFields } from './secret-fields';
import { isParakeetLanguage } from './languages';

const metadataKey = 'shuddhalekhan.settings';
const secretMask = Object.fromEntries(secretFields.map(({ field }) => [field, true])) as Record<typeof secretFields[number]['field'], true>;
const secretRefs = Object.fromEntries(secretFields.map(({ ref, legacyOptional }) => {
  const schema = z.string().min(1).nullable();
  return [ref, legacyOptional ? schema.default(null) : schema];
})) as Record<typeof secretFields[number]['ref'], z.ZodNullable<z.ZodString> | z.ZodDefault<z.ZodNullable<z.ZodString>>>;

const serverSettingsSchema = mobileSettingsSchema.shape.mcpServers.element
  .omit({ token: true })
  .extend({ tokenRef: z.string().min(1).nullable() })
  .strict();

const storedSettingsSchema = z.object(mobileSettingsSchema.shape).omit({
  ...secretMask, mcpServers: true,
}).extend({
  // Accept the legacy field, then discard it. It must never become standing instructions.
  systemPrompt: z.unknown().optional(),
  transcriptionProvider: mobileSettingsSchema.shape.transcriptionProvider.removeDefault().optional(),
  mcpServers: z.array(serverSettingsSchema).max(10),
  ...secretRefs,
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
  return `${metadataKey}.${generation}.${name}`;
}

function readEnvelope(raw: string): Envelope | null {
  try {
    const decoded: unknown = JSON.parse(raw);
    const envelope = envelopeSchema.parse(decoded);
    // Old local inference ignored the endpoint language; keep that behavior when upgrading.
    if (envelope.settings.transcriptionProvider === undefined && envelope.settings.transcriptionSource === 'on-device'
      && !isParakeetLanguage(envelope.settings.language)) envelope.settings.language = '';
    const refs = [
      ...secretFields.map(({ ref, key }) => [envelope.settings[ref], secretKey(envelope.generation, key)]),
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
    ...secretFields.map(({ ref }) => envelope.settings[ref]),
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
    if (raw === null) return { ...defaultSettings, mcpServers: [] };

    const envelope = readEnvelope(raw);
    if (!envelope) throw new Error('Saved settings are corrupt or invalid.');

    try {
      const loadSecret = async (ref: string | null) => {
        if (ref === null) return '';
        const value = await secrets.getItem(ref);
        if (value === null) throw new Error();
        return value;
      };
      const [loadedSecrets, serverTokens] = await Promise.all([
        Promise.all(secretFields.map(async ({ field, ref }) => [field, await loadSecret(envelope.settings[ref])])),
        Promise.all(envelope.settings.mcpServers.map(server => loadSecret(server.tokenRef))),
      ]);
      return mobileSettingsSchema.parse({
        ...envelope.settings,
        ...Object.fromEntries(loadedSecrets),
        mcpServers: envelope.settings.mcpServers.map((server, index) => ({
          id: server.id,
          name: server.name,
          endpoint: server.endpoint,
          enabled: server.enabled,
          ...(server.toolPolicies ? { toolPolicies: server.toolPolicies } : {}),
          token: serverTokens[index] ?? '',
        })),
      });
    } catch {
      throw new Error('Could not load saved settings. Check device secure storage.');
    }
  }

  async function saveSettings(settings: MobileSettings): Promise<MobileSettings> {
    const parsed = mobileSettingsSchema.safeParse(settings);
    if (!parsed.success) throw parsed.error;

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
      const refs = {} as Record<typeof secretFields[number]['ref'], string | null>;
      const publicSettings: Omit<MobileSettings, typeof secretFields[number]['field']> & Partial<Pick<MobileSettings, typeof secretFields[number]['field']>> = { ...parsed.data };
      for (const { field, ref, key } of secretFields) {
        refs[ref] = await storeSecret(key, parsed.data[field]);
        delete publicSettings[field];
      }
      const mcpServers = [];
      for (const [index, server] of parsed.data.mcpServers.entries()) {
        mcpServers.push({
          id: server.id,
          name: server.name,
          endpoint: server.endpoint,
          enabled: server.enabled,
          ...(server.toolPolicies ? { toolPolicies: server.toolPolicies } : {}),
          tokenRef: await storeSecret(`mcp-${index}`, server.token),
        });
      }
      const envelope: Envelope = {
        version: 1,
        generation,
        settings: {
          ...publicSettings,
          ...refs,
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
