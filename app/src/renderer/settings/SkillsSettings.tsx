import { useCallback, useEffect, useState } from 'react';
import { FolderOpen, Plus, RefreshCw } from 'lucide-react';
import type { AgentSkillImport, AgentSkillSummary } from '../../shared/agent-context';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { SectionHeader, SettingsCard } from './ui/SectionHeader';
import { Tag } from './ui/rows';
import { ipcErrorMessage } from './use-settings-persistence';
import type { SettingsSectionProps } from './settings-section-props';

const FIELD_ID_SKILLS = 'agent-skills';

/** null = closed. Create uses simple fields; edit works on the raw SKILL.md so imported frontmatter survives. */
type Editor =
  | { mode: 'create'; name: string; description: string; instructions: string }
  | { mode: 'edit'; name: string; content: string };

/** Standard SKILL.md: JSON strings are valid quoted YAML scalars. */
function buildSkillMarkdown(name: string, description: string, instructions: string): string {
  return `---\nname: ${JSON.stringify(name.trim())}\ndescription: ${JSON.stringify(description.trim())}\n---\n\n${instructions.trim()}\n`;
}

export function SkillsSettings({ config, persistence, settingsIpc }: SettingsSectionProps) {
  const [skills, setSkills] = useState<AgentSkillSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<AgentSkillImport | null>(null);
  const [removeTarget, setRemoveTarget] = useState<string | null>(null);

  /** Runs one file operation at a time; failures stay visible and never touch drafts. */
  const run = useCallback(async (action: () => Promise<void>, fallback: string, onError = setError) => {
    setBusy(true);
    onError(null);
    try {
      await action();
    } catch (cause) {
      onError(ipcErrorMessage(cause, fallback));
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = useCallback(
    () => run(async () => setSkills(await settingsIpc.listSkills()), 'Could not load skills.'),
    [run, settingsIpc],
  );

  useEffect(() => {
    let active = true;
    settingsIpc.listSkills().then(
      (list) => active && setSkills(list),
      (cause) => active && setError(ipcErrorMessage(cause, 'Could not load skills.')),
    );
    return () => {
      active = false;
    };
  }, [settingsIpc]);

  // Main reports enablement from config.agent.disabledSkills; commit the whole set so the renderer copy stays authoritative.
  const commitDisabled = async (list: AgentSkillSummary[]) => {
    await persistence.commit(
      'agent',
      { ...config.agent, disabledSkills: list.filter((skill) => !skill.error && !skill.enabled).map((skill) => skill.name) },
      FIELD_ID_SKILLS,
    );
  };

  const toggle = (name: string, enabled: boolean) => {
    if (!skills) return;
    const next = skills.map((skill) => (skill.name === name ? { ...skill, enabled } : skill));
    void run(async () => {
      await commitDisabled(next);
      setSkills(await settingsIpc.listSkills());
    }, 'Could not change this skill.');
  };

  const openEditor = (name: string) => run(async () => {
    const document = await settingsIpc.readSkill(name);
    setEditorError(null);
    setEditor({ mode: 'edit', name: document.name, content: document.content });
  }, `Could not open ${name}.`);

  const saveEditor = () => {
    if (!editor) return;
    const document = editor.mode === 'create'
      ? { name: editor.name.trim(), content: buildSkillMarkdown(editor.name, editor.description, editor.instructions), create: true }
      : { name: editor.name, content: editor.content, create: false };
    void run(async () => {
      setSkills(await settingsIpc.saveSkill(document));
      setEditor(null);
    }, 'Could not save this skill.', setEditorError);
  };

  const chooseImport = () => run(async () => {
    setImportPreview(await settingsIpc.selectSkillImport());
  }, 'Could not read that skill folder.');

  const confirmImport = (preview: AgentSkillImport) => {
    setImportPreview(null);
    void run(async () => {
      const next = await settingsIpc.importSkill(preview.token);
      setSkills(next);
      // Main stores the imported skill as disabled; mirror that into the renderer's config copy.
      await commitDisabled(next);
    }, `Could not import ${preview.name}.`);
  };

  const confirmRemove = (name: string) => {
    setRemoveTarget(null);
    if (editor?.mode === 'edit' && editor.name === name) setEditor(null);
    void run(async () => setSkills(await settingsIpc.removeSkill(name)), `Could not remove ${name}.`);
  };

  const saveError = error ?? persistence.fieldErrors[FIELD_ID_SKILLS];

  return (
    <div className="space-y-8">
      <SectionHeader
        title="Skills"
        description="Skills teach the agent a workflow. It reads a skill's instructions only when your command needs them."
        actions={(
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />
              Refresh
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void run(settingsIpc.openSkillsFolder, 'Could not open the skills folder.')}>
              <FolderOpen aria-hidden="true" />
              Open folder
            </Button>
          </div>
        )}
      />

      {saveError ? (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {saveError}
        </div>
      ) : null}

      {editor ? (
        <SkillEditor
          editor={editor}
          busy={busy}
          error={editorError}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      ) : null}

      <section aria-labelledby="installed-skills-heading" className="settings-panel">
        <div className="flex items-center justify-between gap-4 px-1">
          <h3 id="installed-skills-heading" className="text-[13px] font-medium text-muted-foreground">Installed skills</h3>
          <div className="flex items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void chooseImport()}>
              Import skill
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || editor !== null}
              onClick={() => {
                setEditorError(null);
                setEditor({ mode: 'create', name: '', description: '', instructions: '' });
              }}
            >
              <Plus aria-hidden="true" />
              Create skill
            </Button>
          </div>
        </div>
        {skills === null ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
            {error ? 'Skills are unavailable. Try Refresh.' : 'Loading skills…'}
          </SettingsCard>
        ) : skills.length === 0 ? (
          <SettingsCard className="py-8 text-center text-sm text-muted-foreground">
            No skills yet. Create one to teach the agent a workflow, or import a folder that contains SKILL.md.
          </SettingsCard>
        ) : (
          <SettingsCard className="divide-y divide-border/50">
            {skills.map((skill) => (
              <div key={skill.name} className="flex items-start justify-between gap-4 py-3.5">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <p className="break-words font-mono text-[13px] font-medium">{skill.name}</p>
                    {skill.error ? <Tag tone="error">Invalid</Tag> : null}
                  </div>
                  {skill.description ? (
                    <p className="break-words text-xs leading-5 text-muted-foreground">{skill.description}</p>
                  ) : null}
                  {skill.error ? (
                    <p className="break-words text-xs leading-5 text-destructive">
                      {skill.error} Edit the skill or fix SKILL.md in the skills folder, then Refresh.
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="ghost" size="sm" disabled={busy || editor !== null} aria-label={`Edit ${skill.name}`} onClick={() => void openEditor(skill.name)}>
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={busy}
                    aria-label={`Remove ${skill.name}`}
                    onClick={() => setRemoveTarget(skill.name)}
                  >
                    Remove
                  </Button>
                  <Switch
                    className="ml-2"
                    checked={skill.enabled && !skill.error}
                    disabled={busy || skill.error !== null}
                    aria-label={`Enable ${skill.name}`}
                    onCheckedChange={(checked) => toggle(skill.name, checked)}
                  />
                </div>
              </div>
            ))}
          </SettingsCard>
        )}
      </section>

      <ConfirmDialog
        open={importPreview !== null}
        title={`Import "${importPreview?.name ?? ''}"?`}
        description={`${importPreview?.description ?? ''} The folder is copied into Shuddhalekhan's skills folder and stays off until you review and enable it.`}
        confirmLabel="Import"
        confirmVariant="default"
        onConfirm={() => {
          if (importPreview) confirmImport(importPreview);
        }}
        onCancel={() => setImportPreview(null)}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        title={`Remove "${removeTarget ?? ''}"?`}
        description="Deletes Shuddhalekhan's copy of this skill and its bundled files. The folder you imported from is not touched."
        confirmLabel="Remove"
        onConfirm={() => {
          if (removeTarget) confirmRemove(removeTarget);
        }}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}

function SkillEditor({
  editor,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  editor: Editor;
  busy: boolean;
  error: string | null;
  onChange: (editor: Editor) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const title = editor.mode === 'create' ? 'Create skill' : `Edit ${editor.name}`;
  const incomplete = editor.mode === 'create'
    ? !editor.name.trim() || !editor.description.trim() || !editor.instructions.trim()
    : !editor.content.trim();

  return (
    <form
      aria-label={title}
      className="settings-panel"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <h3 className="px-1 text-[13px] font-medium text-muted-foreground">{title}</h3>
      <SettingsCard className="space-y-5 py-4">
        {editor.mode === 'create' ? (
          <>
            <div className="space-y-2">
              <Label htmlFor="skill-name" className="text-sm font-medium">Name</Label>
              <Input
                id="skill-name"
                className="h-9 font-mono"
                autoFocus
                value={editor.name}
                placeholder="email-style"
                aria-describedby="skill-name-help"
                onChange={(event) => onChange({ ...editor, name: event.target.value })}
              />
              <p id="skill-name-help" className="text-xs text-muted-foreground">
                Lowercase letters, numbers, and hyphens. This becomes the skill's folder name and cannot be changed later.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skill-description" className="text-sm font-medium">When to use it</Label>
              <Input
                id="skill-description"
                className="h-9"
                value={editor.description}
                placeholder="Use when drafting or replying to email."
                aria-describedby="skill-description-help"
                onChange={(event) => onChange({ ...editor, description: event.target.value })}
              />
              <p id="skill-description-help" className="text-xs text-muted-foreground">
                The agent sees this line on every command and uses it to decide whether to load the instructions.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="skill-instructions" className="text-sm font-medium">Instructions</Label>
              <Textarea
                id="skill-instructions"
                className="min-h-40 font-mono text-[13px]"
                value={editor.instructions}
                placeholder="Keep replies under five sentences. Sign off with my first name."
                onChange={(event) => onChange({ ...editor, instructions: event.target.value })}
              />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="skill-content" className="text-sm font-medium">SKILL.md</Label>
            <Textarea
              id="skill-content"
              className="min-h-72 font-mono text-[13px]"
              autoFocus
              spellCheck={false}
              value={editor.content}
              aria-describedby="skill-content-help"
              onChange={(event) => onChange({ ...editor, content: event.target.value })}
            />
            <p id="skill-content-help" className="text-xs text-muted-foreground">
              Edit the file as written. Keep the name and description between the --- lines; other fields and bundled files are preserved.
            </p>
          </div>
        )}
        {error ? (
          <p role="alert" className="rounded-md bg-destructive/10 px-2.5 py-2 text-xs leading-5 text-destructive break-words">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2 border-t border-border/50 pt-4">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy || incomplete}>
            {busy ? 'Saving…' : 'Save skill'}
          </Button>
        </div>
      </SettingsCard>
    </form>
  );
}
