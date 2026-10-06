/**
 * "New project" modal (POST /api/projects). Only rendered for users with manage_projects;
 * the server checks the permission and validates the target (https git URL on an allowed host,
 * or a local path under an allowed root) again.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Project, SizeTier } from '@server/api-types';
import { SIZE_TIERS, TIER_DEFAULTS } from '@server/api-types';
import { api, isApiError } from '@/api';
import { Button } from '@/components/Button';

const inputClass = 'h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

export function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [tier, setTier] = useState<SizeTier>('Standard');
  const [target, setTarget] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement;
    firstRef.current?.focus();
    return () => {
      const el = restoreRef.current;
      if (el instanceof HTMLElement) el.focus();
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;
    // Keep focus inside the dialog.
    const focusables = [...dialogRef.current.querySelectorAll<HTMLElement>('input, select, button, textarea')].filter((el) => !el.hasAttribute('disabled'));
    if (focusables.length === 0) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields([]);
    try {
      const p = await api.createProject({ name: name.trim(), tier, target: target.trim(), ...(owner.trim() ? { owner: owner.trim() } : {}) });
      onCreated(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
      if (isApiError(err)) setFields(err.fields);
    } finally {
      setBusy(false);
    }
  };

  const invalid = (f: string) => (fields.includes(f) ? true : undefined);
  const t = TIER_DEFAULTS[tier];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-black/40 px-4 py-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={onKeyDown}
        className="w-full max-w-[480px] rounded-lg border bg-background p-5 text-[13px] text-foreground shadow-[var(--shadow-lg)]"
      >
        <h2 id={`${id}-title`} className="m-0 text-[15px] font-semibold">
          New project
        </h2>
        <p className="m-0 mt-1 text-xs text-muted-foreground">Read-only: nothing from the target is installed or executed.</p>
        <form className="mt-4 flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-name`} className="font-medium">
              Name
            </label>
            <input ref={firstRef} id={`${id}-name`} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={invalid('name')} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-target`} className="font-medium">
              Target
            </label>
            <input
              id={`${id}-target`}
              required
              maxLength={2048}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="https://github.com/org/repo"
              aria-invalid={invalid('target')}
              aria-describedby={`${id}-target-hint`}
              className={`${inputClass} font-mono`}
            />
            <span id={`${id}-target-hint`} className="text-xs text-muted-foreground">
              An https URL on github.com, gitlab.com or bitbucket.org, or a local path the server allows.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-tier`} className="font-medium">
              Size tier
            </label>
            <select id={`${id}-tier`} value={tier} onChange={(e) => setTier(e.target.value as SizeTier)} aria-invalid={invalid('tier')} aria-describedby={`${id}-tier-hint`} className={inputClass}>
              {SIZE_TIERS.map((s) => (
                <option key={s} value={s}>
                  {s} · {TIER_DEFAULTS[s].repoRange}
                </option>
              ))}
            </select>
            <span id={`${id}-tier-hint`} className="text-xs text-muted-foreground">
              {t.fit} · scans {t.scanCadence} · graph cap {t.graphNodeCap} nodes
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={`${id}-owner`} className="font-medium">
              Owner <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <input id={`${id}-owner`} maxLength={200} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Payments · A. Chen" className={inputClass} />
          </div>
          {error && (
            <p role="alert" className="m-0 text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !target.trim()}>
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
