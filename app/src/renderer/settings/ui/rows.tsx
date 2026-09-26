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
  neutral: 'border-border/70 bg-muted/50 text-muted-foreground',
  success: 'border-success/25 bg-success/10 text-success',
  warning: 'border-warning/30 bg-warning/10 text-warning',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-primary/25 bg-primary/10 text-primary',
  agent: 'border-agent-accent/30 bg-agent-accent/10 text-agent-accent',
};

export function Tag({ tone = 'neutral', className, children }: TagProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-semibold tracking-wide',
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
    <div className={cn('border-b border-border/60 py-4 last:border-b-0', className)}>
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
    <p id={id} role="alert" className="mt-2 rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-destructive break-words">
      {error}
    </p>
  );
}

interface ToggleRowProps {
  title: string;
  description?: string;
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
  const describedBy = description
    ? [descriptionId, error ? errorId : null].filter(Boolean).join(' ')
    : error
      ? errorId
      : undefined;

  return (
    <RowShell className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-2xl space-y-1.5">
        <p className="text-sm font-semibold">{title}</p>
        {description ? (
          <p id={descriptionId} className="max-w-xl text-xs leading-5 text-muted-foreground">
            {description}
          </p>
        ) : null}
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
    <RowShell className="space-y-2.5">
      <Label id={labelId} className="text-sm font-semibold">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger
          className="h-10 w-full max-w-md"
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
        <p id={descriptionId} className="max-w-xl text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      <FieldError id={errorId} error={error} />
    </RowShell>
  );
}

function blurOnEnter(event: React.KeyboardEvent<HTMLInputElement>): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.currentTarget.blur();
  }
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

  const showError = validationError ?? error;
  const describedBy = [
    description ? descriptionId : null,
    warning ? warningId : null,
    showError ? errorId : null,
  ].filter(Boolean).join(' ') || undefined;

  return (
    <RowShell className="space-y-2.5">
      <Label id={labelId} htmlFor={inputId} className="text-sm font-semibold">
        {label}
      </Label>
      <Input
        id={inputId}
        className="h-10 max-w-xl"
        value={currentValue}
        placeholder={placeholder}
        onChange={handleChange}
        onBlur={commit}
        onKeyDown={blurOnEnter}
        aria-labelledby={labelId}
        aria-invalid={showError ? true : undefined}
        aria-describedby={describedBy}
      />
      {description ? (
        <p id={descriptionId} className="max-w-xl text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {warning ? (
        <p id={warningId} className="max-w-xl text-xs leading-5 text-warning break-words">
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
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <span id={labelId} className="text-sm text-muted-foreground">
          {label}
        </span>
        <span className="text-sm font-semibold break-words sm:text-right">{value}</span>
      </div>
    </RowShell>
  );
}

export function Keycaps({ value, label }: { value: string; label?: string }) {
  const keys = value.split(' + ');
  return (
    <div className="flex flex-wrap items-center gap-1" aria-label={label ?? value}>
      {keys.map((key, i) => (
        <span key={key} className="flex items-center gap-1">
          <kbd className="inline-flex min-h-7 items-center justify-center rounded-md border border-border/80 bg-muted/70 px-2 py-1 font-mono text-[10px] font-semibold text-foreground shadow-sm">
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
  );
}
