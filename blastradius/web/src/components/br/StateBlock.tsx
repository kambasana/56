/**
 * StateBlock fills empty, no-results, error, not-allowed and loading states. It always keeps the
 * page's frame (render it inside the table or section it replaces) and offers a way forward
 * (docs/UX.md §6).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Permission } from '@server/permissions';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export interface StateAction {
  label: string;
  onClick?: () => void;
  /** In-app link instead of a button. */
  to?: string;
}

function Actions({ actions, primary }: { actions?: readonly StateAction[]; primary?: StateAction }) {
  const all = [...(primary ? [{ ...primary, primary: true }] : []), ...(actions ?? []).map((a) => ({ ...a, primary: false }))];
  if (all.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {all.map((a) => (
        <Button key={a.label} asChild={!!a.to} size="sm" variant={a.primary ? 'default' : 'outline'} className="h-7 px-3 text-label" onClick={a.to ? undefined : a.onClick}>
          {a.to ? <Link to={a.to}>{a.label}</Link> : a.label}
        </Button>
      ))}
    </div>
  );
}

/** Plain names for the permissions a disabled control can be missing. */
export const PERMISSION_NAME: Partial<Record<Permission, string>> = {
  review: 'Triage',
  accept_risk: 'Accept risk',
  manage_alert_rules: 'Alert rules',
  send_to_destinations: 'Send to destinations',
  build_reports: 'Build reports',
  review_entity_links: 'Review entity links',
  manage_projects: 'Manage projects',
  manage_integrations: 'Manage integrations',
  manage_members: 'Manage members',
};

/** "Needs the Triage permission: ask an admin." */
export function needsPermissionText(permission: Permission, admins?: readonly string[]): string {
  const name = PERMISSION_NAME[permission] ?? permission;
  const who = admins && admins.length > 0 ? ` (${admins.join(', ')})` : '';
  return `Needs the ${name} permission: ask an admin${who}.`;
}

/** The one-line reason under a disabled control. Pair it with aria-describedby on the control. */
export function NotAllowedHint({ id, permission, admins, className }: { id?: string; permission: Permission; admins?: readonly string[]; className?: string }) {
  return (
    <span id={id} data-slot="not-allowed" className={cn('text-label text-text-secondary', className)}>
      {needsPermissionText(permission, admins)}
    </span>
  );
}

export type StateBlockProps =
  | { kind: 'all-clear'; title: ReactNode; description?: ReactNode; actions?: readonly StateAction[]; className?: string }
  | { kind: 'no-results'; title: ReactNode; description?: ReactNode; actions: readonly StateAction[]; className?: string }
  | { kind: 'error'; title: ReactNode; cause: string; onRetry?: () => void; actions?: readonly StateAction[]; className?: string }
  | { kind: 'not-allowed'; title: ReactNode; permission: Permission; admins?: readonly string[]; className?: string }
  | { kind: 'loading'; label?: string; rows?: number; columns?: number; className?: string };

export function StateBlock(props: StateBlockProps) {
  const base = 'flex flex-col gap-2 rounded-xl p-4 text-body';
  switch (props.kind) {
    case 'all-clear':
      return (
        <div role="status" data-slot="state-block" data-kind="all-clear" className={cn(base, 'items-center bg-success-soft px-3 py-6 text-center', props.className)}>
          <strong className="font-semibold text-success">
            <span aria-hidden="true">✓ </span>
            {props.title}
          </strong>
          {props.description && <span className="text-text-secondary">{props.description}</span>}
          <Actions actions={props.actions} />
        </div>
      );
    case 'no-results':
      return (
        <div role="status" data-slot="state-block" data-kind="no-results" className={cn(base, 'border px-4 py-6', props.className)}>
          <strong className="font-semibold">{props.title}</strong>
          <span className="text-text-secondary">{props.description ?? 'Try one of these:'}</span>
          <Actions actions={props.actions} />
        </div>
      );
    case 'error':
      return (
        <div role="alert" data-slot="state-block" data-kind="error" className={cn(base, 'border border-destructive bg-destructive-soft', props.className)}>
          <strong className="font-semibold text-destructive">{props.title}</strong>
          <code className="block rounded-[6px] border bg-background p-2 font-mono text-[12px] break-words whitespace-pre-wrap text-foreground">{props.cause}</code>
          <Actions primary={props.onRetry ? { label: 'Retry', onClick: props.onRetry } : undefined} actions={props.actions} />
        </div>
      );
    case 'not-allowed':
      return (
        <div role="status" data-slot="state-block" data-kind="not-allowed" className={cn(base, 'border', props.className)}>
          <strong className="font-semibold">{props.title}</strong>
          <NotAllowedHint permission={props.permission} admins={props.admins} />
        </div>
      );
    case 'loading': {
      const rows = props.rows ?? 3;
      const cols = props.columns ?? 3;
      return (
        <div role="status" aria-busy="true" aria-label={props.label ?? 'Loading'} data-slot="state-block" data-kind="loading" className={cn('overflow-hidden rounded-xl border', props.className)}>
          {Array.from({ length: rows }, (_, r) => (
            <div key={r} className="grid gap-3 border-b p-3 last:border-b-0" style={{ gridTemplateColumns: `96px repeat(${Math.max(1, cols - 1)}, minmax(0, 1fr))` }}>
              {Array.from({ length: cols }, (_, c) => (
                <Skeleton key={c} className="h-3" style={{ width: c === 1 ? `${70 - r * 8}%` : undefined }} />
              ))}
            </div>
          ))}
        </div>
      );
    }
  }
}
