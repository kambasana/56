/** Empty, loading, error and 403 states on top of the shadcn/ui Empty component. */
import type { ReactNode } from 'react';
import { CircleAlert, ShieldX } from 'lucide-react';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** "status" for empty/loading, "alert" for errors. */
  role?: 'status' | 'alert';
}

export function EmptyState({ title, description, action, icon, className, role = 'status' }: EmptyStateProps) {
  return (
    <Empty role={role} className={cn('gap-4 p-6 md:p-10', className)}>
      <EmptyHeader>
        {icon && <EmptyMedia variant="icon">{icon}</EmptyMedia>}
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <EmptyState
      title={
        <span className="inline-flex items-center gap-2 text-sm font-normal text-muted-foreground">
          <Spinner role="presentation" aria-label={undefined} aria-hidden="true" />
          {label}
        </span>
      }
    />
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <EmptyState
      role="alert"
      icon={<CircleAlert className="text-destructive" />}
      title="Could not load this page"
      description={message}
      action={
        onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Retry
          </Button>
        ) : undefined
      }
    />
  );
}

/** 403 state for routes the user's roles do not include. */
export function ForbiddenState({ page }: { page?: string }) {
  return (
    <EmptyState
      icon={<ShieldX />}
      title="You don't have access to this page"
      description={`Your roles do not include the ${page ? `"${page}" ` : ''}page permission. An org admin can change roles in Settings.`}
    />
  );
}
