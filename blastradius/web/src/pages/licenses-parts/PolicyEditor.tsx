/**
 * Licence policy editor (PUT /api/license-policy, needs manage_projects). One column: a radio
 * group per category (three choices, so radios, docs/UX.md §7), then per-licence overrides by SPDX
 * id. Unknown licences can only be reviewed or denied. The server validates and audits the policy.
 */
import { useId, useState } from 'react';
import { toast } from 'sonner';
import type { LicenseCategory, LicensePolicy, LicensePolicyDecision } from '@server/api-types';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CATEGORIES, CATEGORY_HINT, CATEGORY_LABEL, DECISION_LABEL } from './labels';

const CHOICES: readonly LicensePolicyDecision[] = ['allow', 'review', 'deny'];
const SPDX_ID = /^[A-Za-z0-9.+-]{1,100}$/;

function DecisionRadios({ name, legend, hint, value, choices, onChange }: { name: string; legend: string; hint: string; value: LicensePolicyDecision; choices: readonly LicensePolicyDecision[]; onChange: (d: LicensePolicyDecision) => void }) {
  const hintId = `${name}-hint`;
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0" aria-describedby={hintId}>
      <legend className="p-0 text-label font-medium">{legend}</legend>
      <span id={hintId} className="text-caption text-text-secondary">
        {hint}
      </span>
      <div className="flex flex-wrap gap-3">
        {choices.map((c) => (
          <label key={c} className="inline-flex items-center gap-1.5 text-label">
            <input type="radio" name={name} value={c} checked={value === c} onChange={() => onChange(c)} className="size-3.5 accent-foreground" />
            {DECISION_LABEL[c]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function PolicyEditor({ open, onOpenChange, policy, defaultPolicy, onSaved }: { open: boolean; onOpenChange: (v: boolean) => void; policy: LicensePolicy; defaultPolicy: LicensePolicy; onSaved: () => void }) {
  const id = useId();
  const [draft, setDraft] = useState<LicensePolicy>(policy);
  const [newId, setNewId] = useState('');
  const [newDecision, setNewDecision] = useState<LicensePolicyDecision>('deny');
  const [idError, setIdError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openedWith, setOpenedWith] = useState<LicensePolicy | null>(null);
  if (open && openedWith !== policy) {
    // Reset the draft each time the dialog opens on a (possibly newer) policy.
    setOpenedWith(policy);
    setDraft(policy);
    setError(null);
    setIdError(null);
  }

  const setCategory = (c: LicenseCategory, d: LicensePolicyDecision) => setDraft((p) => ({ ...p, categories: { ...p.categories, [c]: d } }));
  const addId = () => {
    const v = newId.trim();
    if (!SPDX_ID.test(v)) {
      setIdError('Enter one SPDX licence id, e.g. AGPL-3.0-only.');
      return;
    }
    setIdError(null);
    setDraft((p) => ({ ...p, ids: [...p.ids.filter((r) => r.id !== v), { id: v, decision: newDecision }] }));
    setNewId('');
  };
  const save = async (next: LicensePolicy | null) => {
    setBusy(true);
    setError(null);
    try {
      if (next) await api.updateLicensePolicy(next);
      else await api.resetLicensePolicy();
      toast.success(next ? 'Licence policy saved' : 'Licence policy reset to the default template');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the policy.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Licence policy</DialogTitle>
          <DialogDescription>Your rules for each licence category, applied to every project at once. A licence rule wins over its category. Not legal advice.</DialogDescription>
        </DialogHeader>
        <form
          aria-label="Licence policy"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save(draft);
          }}
        >
          {CATEGORIES.map((c) => (
            <DecisionRadios
              key={c}
              name={`${id}-${c}`}
              legend={CATEGORY_LABEL[c]}
              hint={c === 'unknown' ? `${CATEGORY_HINT[c]} Unknown licences can only be reviewed or denied.` : CATEGORY_HINT[c]}
              value={draft.categories[c]}
              choices={c === 'unknown' ? CHOICES.filter((x) => x !== 'allow') : CHOICES}
              onChange={(d) => setCategory(c, d)}
            />
          ))}
          <div className="flex flex-col gap-2">
            <span className="text-label font-medium">Licence rules (optional)</span>
            {draft.ids.length === 0 ? (
              <span className="text-caption text-text-secondary">No licence rules. Categories decide.</span>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {draft.ids.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px]">{r.id}</span>
                    <span className="text-label">{DECISION_LABEL[r.decision]}</span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => setDraft((p) => ({ ...p, ids: p.ids.filter((x) => x.id !== r.id) }))} aria-label={`Remove the rule for ${r.id}`}>
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-new`}>SPDX licence id</Label>
                <Input
                  id={`${id}-new`}
                  value={newId}
                  onChange={(e) => setNewId(e.target.value)}
                  onBlur={() => setIdError(newId.trim() && !SPDX_ID.test(newId.trim()) ? 'Enter one SPDX licence id, e.g. AGPL-3.0-only.' : null)}
                  placeholder="AGPL-3.0-only"
                  className="h-7 w-48 font-mono text-[12px]"
                  aria-invalid={idError ? true : undefined}
                  aria-describedby={idError ? `${id}-err` : undefined}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-dec`}>Decision</Label>
                <select id={`${id}-dec`} value={newDecision} onChange={(e) => setNewDecision(e.target.value as LicensePolicyDecision)} className="h-7 rounded-md border bg-background px-2 text-label">
                  {CHOICES.map((c) => (
                    <option key={c} value={c}>
                      {DECISION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </div>
              <Button type="button" variant="outline" size="sm" className="h-7" onClick={addId}>
                Add rule
              </Button>
            </div>
            {idError && (
              <span id={`${id}-err`} role="alert" className="text-label text-destructive">
                {idError}
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="m-0 text-label text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)} title={`Default: ${CATEGORIES.map((c) => `${CATEGORY_LABEL[c]} ${DECISION_LABEL[defaultPolicy.categories[c]].toLowerCase()}`).join(', ')}`}>
              Reset to default
            </Button>
            <span className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Saving…' : 'Save policy'}
              </Button>
            </span>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
