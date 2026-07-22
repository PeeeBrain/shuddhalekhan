import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CredentialKind, CredentialStatus } from '../../../types/ipc';
import type { SettingsIpc } from '../settings-ipc';

interface CredentialControlProps {
  credential: CredentialKind;
  label: string;
  settingsIpc: SettingsIpc;
  documentImport?: boolean;
}

export function CredentialControl({ credential, label, settingsIpc, documentImport = false }: CredentialControlProps) {
  const inputId = useId();
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    settingsIpc.getCredentialStatus(credential)
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError('Unable to check secure credential storage.');
      });
    return () => {
      active = false;
    };
  }, [credential, settingsIpc]);

  const save = async () => {
    if (!value) return;
    setError(null);
    if (documentImport) {
      try {
        const document = JSON.parse(value) as Record<string, unknown>;
        if (document.type !== 'service_account' || typeof document.client_email !== 'string'
          || typeof document.private_key !== 'string' || !document.private_key.includes('BEGIN PRIVATE KEY')
          || typeof document.token_uri !== 'string' || !document.token_uri.startsWith('https://')) {
          setError('The document must contain a service-account type, client_email, private_key, and HTTPS token_uri.');
          return;
        }
      } catch {
        setError('Select a valid Google service-account JSON document.');
        return;
      }
    }
    try {
      const next = await settingsIpc.saveCredential(credential, value);
      setValue('');
      setStatus(next);
      if (!next.available) setError(next.message);
    } catch {
      setError('Unable to save credential securely.');
    }
  };

  const remove = async () => {
    setError(null);
    try {
      setStatus(await settingsIpc.removeCredential(credential));
    } catch {
      setError('Unable to remove credential securely.');
    }
  };

  const isSaved = status?.available && status.exists;
  const unavailableMessage = status && !status.available ? status.message : null;

  return (
    <div className="space-y-2 border-b border-border/70 py-5">
      <Label htmlFor={inputId} className="text-sm font-medium">{label}</Label>
      {documentImport ? (
        <Input
          id={inputId}
          type="file"
          accept="application/json,.json"
          disabled={status?.available === false}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            file.text().then(setValue).catch(() => setError('Unable to read the selected document.'));
          }}
        />
      ) : (
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={isSaved ? 'Enter a replacement credential' : 'Enter credential'}
          disabled={status?.available === false}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
      )}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!value || status?.available === false} onClick={() => void save()}>
          {isSaved ? (documentImport ? 'Replace document' : 'Replace key') : (documentImport ? 'Import document' : 'Save key')}
        </Button>
        {isSaved ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void remove()}>
            {documentImport ? 'Remove document' : 'Remove key'}
          </Button>
        ) : null}
        {isSaved ? <span className="text-xs text-muted-foreground">Saved securely</span> : null}
      </div>
      {unavailableMessage || error ? (
        <p role="alert" className="text-xs text-destructive">{unavailableMessage ?? error}</p>
      ) : null}
    </div>
  );
}
