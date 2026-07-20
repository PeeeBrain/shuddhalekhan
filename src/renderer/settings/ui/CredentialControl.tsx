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
}

export function CredentialControl({ credential, label, settingsIpc }: CredentialControlProps) {
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
      <Input
        id={inputId}
        type="password"
        autoComplete="off"
        value={value}
        placeholder={isSaved ? 'Enter a replacement key' : 'Enter API key'}
        disabled={status?.available === false}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={!value || status?.available === false} onClick={() => void save()}>
          {isSaved ? 'Replace key' : 'Save key'}
        </Button>
        {isSaved ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void remove()}>
            Remove key
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
