import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

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
    <div role={role} className={cn('flex flex-col items-center justify-center gap-2 px-6 py-12 text-center', className)}>
      {icon && <div className="text-muted-foreground [&_svg]:size-6">{icon}</div>}
      <p className="m-0 text-sm font-semibold">{title}</p>
      {description && <p className="m-0 max-w-md text-[13px] leading-[18px] text-muted-foreground">{description}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <EmptyState title={<span className="font-normal text-muted-foreground">{label}</span>} />;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <EmptyState
      role="alert"
      title="Could not load this page"
      description={message}
      action={
        onRetry ? (
          <button type="button" onClick={onRetry} className="h-8 cursor-pointer rounded-md border px-3 text-[13px] hover:bg-accent">
            Retry
          </button>
        ) : undefined
      }
    />
  );
}

/** 403 state for routes the user's roles do not include. */
export function ForbiddenState({ page }: { page?: string }) {
  return (
    <EmptyState
      title="You don't have access to this page"
      description={`Your roles do not include the ${page ? `"${page}" ` : ''}page permission. An org admin can change roles in Settings.`}
    />
  );
}
