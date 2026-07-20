import { useId, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Windows as WindowsIcon } from '@/components/ui/svgs/windows';

export type TagTone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'agent';

interface TagProps {
  tone?: TagTone;
  className?: string;
  children: React.ReactNode;
}

const TAG_TONE_CLASS: Record<TagTone, string> = {
  neutral: 'text-muted-foreground bg-muted/40',
  success: 'text-success bg-success/10',
  warning: 'text-warning bg-warning/10',
  error: 'text-destructive bg-destructive/10',
  info: 'text-primary bg-primary/10',
  agent: 'text-agent-accent bg-agent-accent/10',
};

export function Tag({ tone = 'neutral', className, children }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        TAG_TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

interface RowShellProps {
  children: React.ReactNode;
  className?: string;
}

function RowShell({ children, className }: RowShellProps) {
  return (
    <div className={cn('border-b border-border/70 py-5', className)}>
      {children}
    </div>
  );
}

interface FieldErrorProps {
  id: string;
  error?: string;
}

function FieldError({ id, error }: FieldErrorProps) {
  if (!error) return null;
  return (
    <p id={id} role="alert" className="mt-2 text-xs text-destructive break-words">
      {error}
    </p>
  );
}

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  tone?: 'default' | 'agent';
  errorId: string;
  error?: string;
  onChange: (checked: boolean) => void;
}

export function ToggleRow({
  title,
  description,
  checked,
  tone = 'default',
  errorId,
  error,
  onChange,
}: ToggleRowProps) {
  const descriptionId = useId();
  const describedBy = [descriptionId, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <RowShell className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
        {errorId ? (
          <FieldError id={errorId} error={error} />
        ) : null}
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={title}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={
          tone === 'agent' && checked
            ? 'data-[state=checked]:bg-agent-accent data-[state=checked]:border-agent-accent/70'
            : ''
        }
      />
    </RowShell>
  );
}

interface SelectRowProps {
  label: string;
  description?: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  errorId: string;
  error?: string;
  onChange: (value: string) => void;
}

export function SelectRow({
  label,
  description,
  value,
  options,
  errorId,
  error,
  onChange,
}: SelectRowProps) {
  const labelId = useId();
  const descriptionId = useId();
  const describedBy = [description ? descriptionId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ') || undefined;
  return (
    <RowShell className="space-y-2">
      <Label id={labelId} className="text-sm font-medium">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="w-full max-w-xs"
          aria-label={label}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value || '__auto__'}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      <FieldError id={errorId} error={error} />
    </RowShell>
  );
}

interface DraftTextRowProps {
  label: string;
  value: string;
  placeholder?: string;
  description?: string;
  warning?: string;
  errorId: string;
  error?: string;
  validate?: (value: string) => string | null;
  onCommit: (value: string) => void;
  clearError?: () => void;
}

export function DraftTextRow({
  label,
  value,
  placeholder,
  description,
  warning,
  errorId,
  error,
  validate,
  onCommit,
  clearError,
}: DraftTextRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const inputId = useId();
  const labelId = useId();
  const descriptionId = useId();
  const warningId = useId();
  const currentValue = draft ?? value;

  const runValidation = (candidate: string): boolean => {
    if (validate) {
      const message = validate(candidate);
      if (message) {
        setValidationError(message);
        return false;
      }
    }
    setValidationError(null);
    return true;
  };

  const commit = () => {
    const candidate = currentValue;
    if (candidate === value) {
      setDraft(null);
      return;
    }
    if (!runValidation(candidate)) {
      return;
    }
    onCommit(candidate);
    setDraft(null);
  };

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setDraft(event.target.value);
    if (validationError) setValidationError(null);
    clearError?.();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.currentTarget.blur();
    }
  };

  const showError = validationError ?? error;
  const describedBy = [
    description ? descriptionId : null,
    warning ? warningId : null,
    showError ? errorId : null,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <RowShell className="space-y-2">
      <Label id={labelId} htmlFor={inputId} className="text-sm font-medium">
        {label}
      </Label>
      <Input
        id={inputId}
        value={currentValue}
        placeholder={placeholder}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        aria-labelledby={labelId}
        aria-invalid={showError ? true : undefined}
        aria-describedby={describedBy}
      />
      {description ? (
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {warning ? (
        <p id={warningId} className="text-xs text-warning break-words">
          {warning}
        </p>
      ) : null}
      <FieldError id={errorId} error={showError ?? undefined} />
    </RowShell>
  );
}

interface ReadOnlyRowProps {
  label: string;
  value: string;
}

export function ReadOnlyRow({ label, value }: ReadOnlyRowProps) {
  const labelId = useId();

  return (
    <RowShell>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
      >
        <span id={labelId} className="text-sm text-muted-foreground">
          {label}
        </span>
        <span className="text-sm font-medium break-words">{value}</span>
      </div>
    </RowShell>
  );
}

interface KeyRowProps {
  label: string;
  value: string;
}

export function KeyRow({ label, value }: KeyRowProps) {
  const keys = value.split(' + ');
  const labelId = useId();
  return (
    <RowShell>
      <div
        role="group"
        aria-labelledby={labelId}
        className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
      >
        <span id={labelId} className="text-sm text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1" aria-label={`${label} shortcut: ${value}`}>
          {keys.map((key, i) => (
            <span key={`${key}-${i}`} className="flex items-center gap-1">
              <kbd className="inline-flex items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                {key === 'Win' ? (
                  <>
                    <WindowsIcon className="size-3 text-primary" aria-hidden="true" />
                    <span className="sr-only">Win</span>
                  </>
                ) : (
                  key
                )}
              </kbd>
              {i < keys.length - 1 ? (
                <span className="text-xs text-muted-foreground/60">+</span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
    </RowShell>
  );
}
