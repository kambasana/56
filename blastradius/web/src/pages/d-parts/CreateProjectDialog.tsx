/**
 * "New project" dialog (POST /api/projects): a shadcn Dialog with Field inputs and a Select for
 * the size tier. Only rendered for users with manage_projects; the server checks the permission
 * and validates the target (https git URL on an allowed host, or a local path under an allowed
 * root) again. Field errors from the server are shown under the field they belong to.
 */
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import type { Project, SizeTier } from '@server/api-types';
import { SIZE_TIERS, TIER_DEFAULTS } from '@server/api-types';
import { api, isApiError } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';

const FORM_FIELDS = ['name', 'target', 'tier', 'owner'] as const;
type FormField = (typeof FORM_FIELDS)[number];

export function CreateProjectDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (p: Project) => void }) {
  const id = useId();
  const [name, setName] = useState('');
  const [tier, setTier] = useState<SizeTier>('Standard');
  const [target, setTarget] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<string[]>([]);

  // Start clean each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName('');
    setTier('Standard');
    setTarget('');
    setOwner('');
    setError(null);
    setFields([]);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFields([]);
    try {
      const p = await api.createProject({ name: name.trim(), tier, target: target.trim(), ...(owner.trim() ? { owner: owner.trim() } : {}) });
      toast.success(`Project “${p.name}” created`, { description: 'Run its first scan from the Scans page.' });
      onCreated(p);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the project.');
      if (isApiError(err)) setFields(err.fields);
    } finally {
      setBusy(false);
    }
  };

  // The server message goes under the first field it names; otherwise in an alert at the bottom.
  const errorField: FormField | null = error ? (FORM_FIELDS.find((f) => fields.includes(f)) ?? null) : null;
  const invalid = (f: FormField) => (fields.includes(f) ? true : undefined);
  const fieldError = (f: FormField) => (errorField === f ? <FieldError>{error}</FieldError> : null);
  const t = TIER_DEFAULTS[tier];

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[480px]">
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-5" noValidate={false}>
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>Read-only: nothing from the target is installed or executed.</DialogDescription>
          </DialogHeader>
          <FieldGroup className="gap-4">
            <Field data-invalid={invalid('name')}>
              <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
              <Input id={`${id}-name`} required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={invalid('name')} autoComplete="off" />
              {fieldError('name')}
            </Field>
            <Field data-invalid={invalid('target')}>
              <FieldLabel htmlFor={`${id}-target`}>Target</FieldLabel>
              <Input
                id={`${id}-target`}
                required
                maxLength={2048}
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder="https://github.com/org/repo"
                aria-invalid={invalid('target')}
                aria-describedby={`${id}-target-hint`}
                className="font-mono"
                autoComplete="off"
              />
              <FieldDescription id={`${id}-target-hint`}>An https URL on github.com, gitlab.com or bitbucket.org, or a local path the server allows.</FieldDescription>
              {fieldError('target')}
            </Field>
            <Field data-invalid={invalid('tier')}>
              <FieldLabel htmlFor={`${id}-tier`}>Size tier</FieldLabel>
              <Select value={tier} onValueChange={(v) => setTier(v as SizeTier)}>
                <SelectTrigger id={`${id}-tier`} className="w-full" aria-invalid={invalid('tier')} aria-describedby={`${id}-tier-hint`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_TIERS.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s} · {TIER_DEFAULTS[s].repoRange}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription id={`${id}-tier-hint`}>
                {t.fit} · scans {t.scanCadence} · graph cap {t.graphNodeCap} nodes
              </FieldDescription>
              {fieldError('tier')}
            </Field>
            <Field data-invalid={invalid('owner')}>
              <FieldLabel htmlFor={`${id}-owner`}>
                Owner <span className="font-normal text-muted-foreground">(optional)</span>
              </FieldLabel>
              <Input id={`${id}-owner`} maxLength={200} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Payments · A. Chen" aria-invalid={invalid('owner')} />
              {fieldError('owner')}
            </Field>
          </FieldGroup>
          {error && !errorField && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={busy}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !name.trim() || !target.trim()}>
              {busy && <Spinner role={undefined} aria-label={undefined} aria-hidden="true" />}
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
