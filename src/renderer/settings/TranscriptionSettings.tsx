import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { X } from 'lucide-react';
import { SectionHeader } from './ui/SectionHeader';
import { Tag, ToggleRow, SelectRow } from './ui/rows';
import { SetupChecklist } from './SetupChecklist';
import { WHISPER_LANGUAGES } from './settings-model';
import type { SettingsSectionProps } from './settings-section-props';
import type { AppConfig } from '../../types/ipc';

type WhisperTestState = 'idle' | 'checking' | 'success' | 'failed';

const FIELD_ID_WHISPER = 'whisper-url';
const FIELD_ID_TASK = 'task';
const FIELD_ID_LANGUAGE = 'language';
const FIELD_ID_FILER = 'filler-words';
const FIELD_ID_DICTIONARY = 'dictionary';

export function TranscriptionSettings({
  config,
  persistence,
  onNavigate,
  settingsIpc,
}: SettingsSectionProps) {
  const { commit, fieldErrors, clearFieldError } = persistence;
  const localEndpoint = config.transcription.providers.localWhisperCpp.endpoint;
  const [whisperDraft, setWhisperDraft] = useState(localEndpoint);
  const [whisperValidationError, setWhisperValidationError] = useState<string | null>(null);
  const [whisperTestState, setWhisperTestState] = useState<WhisperTestState>('idle');
  const whisperErrorId = useId();
  const whisperLabelId = useId();
  const whisperInputId = useId();

  const whisperValidation = (value: string): string | null => {
    if (!value.trim()) return 'Endpoint URL is required.';
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return 'Endpoint must use HTTP or HTTPS.';
      }
      return null;
    } catch {
      return 'Enter a valid URL (e.g. http://localhost:8080/inference).';
    }
  };

  const testWhisperConnection = async () => {
    const candidate = whisperDraft;
    const validationError = whisperValidation(candidate);
    setWhisperValidationError(validationError);
    if (validationError) return;
    if (candidate !== localEndpoint) {
      await commit('transcription', {
        ...config.transcription,
        providers: {
          ...config.transcription.providers,
          localWhisperCpp: { endpoint: candidate },
        },
      }, FIELD_ID_WHISPER);
    }
    setWhisperTestState('checking');
    const reachable = await settingsIpc.checkTranscriptionServer();
    setWhisperTestState(reachable ? 'success' : 'failed');
  };

  const whisperError =
    whisperValidationError ?? fieldErrors[FIELD_ID_WHISPER];

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Transcription"
        description="Configure where recordings are transcribed and how language is handled."
      />
      {!config.setupChecklistDismissed ? (
        <SetupChecklist config={config} onNavigate={onNavigate} persistence={persistence} />
      ) : null}
      <div className="rounded-lg border border-border/60 bg-card px-6">
        <SelectRow
          label="Provider"
          value={config.transcription.activeProvider}
          options={[{ value: 'local-whisper-cpp', label: 'Local whisper.cpp' }]}
          errorId={useId()}
          onChange={() => undefined}
        />
        <ToggleRow
          title="Clean transcription"
          description="Remove common filler words before dictation text is injected."
          checked={config.removeFillerWords}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_FILER]}
          onChange={(checked) => commit('removeFillerWords', checked, FIELD_ID_FILER)}
        />
        <div className="space-y-2 border-b border-border/70 py-5">
          <Label id={whisperLabelId} htmlFor={whisperInputId} className="text-sm font-medium">
            Endpoint
          </Label>
          <Input
            id={whisperInputId}
            value={whisperDraft}
            placeholder="http://localhost:8080/inference"
            onChange={(e) => {
              setWhisperDraft(e.target.value);
              setWhisperValidationError(null);
              clearFieldError(FIELD_ID_WHISPER);
              setWhisperTestState('idle');
            }}
            onBlur={() => {
              if (whisperDraft === localEndpoint) return;
              const validationError = whisperValidation(whisperDraft);
              setWhisperValidationError(validationError);
              if (!validationError) {
                commit('transcription', {
                  ...config.transcription,
                  providers: {
                    ...config.transcription.providers,
                    localWhisperCpp: { endpoint: whisperDraft },
                  },
                }, FIELD_ID_WHISPER);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.currentTarget.blur();
              }
            }}
            aria-labelledby={whisperLabelId}
            aria-invalid={whisperError ? true : undefined}
            aria-describedby={whisperError ? whisperErrorId : undefined}
          />
          {whisperError ? (
            <p id={whisperErrorId} role="alert" className="text-xs text-destructive break-words">
              {whisperError}
            </p>
          ) : null}
          <div className="flex items-center gap-3 pt-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={whisperTestState === 'checking' || whisperValidation(whisperDraft) !== null}
              onClick={testWhisperConnection}
            >
              {whisperTestState === 'checking' ? 'Checking...' : 'Check server'}
            </Button>
            {whisperTestState === 'success' ? (
              <Tag tone="success">Reachable</Tag>
            ) : null}
            {whisperTestState === 'failed' ? (
              <div className="flex min-w-0 items-center gap-2">
                <Tag tone="error">Unavailable</Tag>
                <span className="text-xs text-destructive">
                  Could not reach endpoint. Check that the whisper.cpp server is running.
                </span>
              </div>
            ) : null}
          </div>
        </div>
        <SelectRow
          label="Mode"
          value={config.task}
          options={[
            { value: 'transcribe', label: 'Transcribe spoken language' },
            { value: 'translate', label: 'Translate speech to English' },
          ]}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_TASK]}
          onChange={(value) => commit('task', value as AppConfig['task'], FIELD_ID_TASK)}
        />
        <SelectRow
          label="Spoken language"
          value={config.language}
          options={WHISPER_LANGUAGES}
          errorId={useId()}
          error={fieldErrors[FIELD_ID_LANGUAGE]}
          onChange={(value) => commit('language', value, FIELD_ID_LANGUAGE)}
        />
        <DictionaryRow
          dictionary={config.dictionary}
          error={fieldErrors[FIELD_ID_DICTIONARY]}
          onChange={(next) => commit('dictionary', next, FIELD_ID_DICTIONARY)}
        />
      </div>
      <p
        role="note"
        aria-label="Transcription privacy note"
        className="px-6 text-xs text-muted-foreground"
      >
        Recorded audio is sent to the configured local endpoint for transcription.
      </p>
    </div>
  );
}

interface DictionaryRowProps {
  dictionary: string[];
  error?: string;
  onChange: (next: string[]) => void;
}

function DictionaryRow({ dictionary, error, onChange }: DictionaryRowProps) {
  const [inputValue, setInputValue] = useState('');
  const errorId = useId();

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      e.preventDefault();
      const newWord = inputValue.trim();
      if (!dictionary.includes(newWord)) {
        onChange([...dictionary, newWord]);
      }
      setInputValue('');
    }
  };

  const removeWord = (wordToRemove: string) => {
    onChange(dictionary.filter((word) => word !== wordToRemove));
  };

  return (
    <div className="space-y-3 border-b border-border/70 py-5">
      <div className="space-y-1">
        <Label className="text-sm font-medium">Personal dictionary</Label>
        <p className="text-xs text-muted-foreground">
          Add specific names, technical terms, or acronyms to help transcription. Press Enter to add.
        </p>
      </div>
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a word and press Enter..."
        aria-label="Add dictionary word"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      <FieldError id={errorId} error={error} />
      <div className="flex flex-wrap gap-2">
        {dictionary.map((word) => (
          <span
            key={word}
            className="group inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-sm font-medium text-secondary-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
          >
            {word}
            <button
              type="button"
              onClick={() => removeWord(word)}
              aria-label={`Remove ${word}`}
              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {dictionary.length === 0 ? (
          <span className="text-xs text-muted-foreground italic px-1 py-1.5">
            No words added yet.
          </span>
        ) : null}
      </div>
    </div>
  );
}

function FieldError({ id, error }: { id: string; error?: string }) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive break-words">
      {error}
    </p>
  );
}
