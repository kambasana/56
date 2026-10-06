/**
 * Small UI pieces shared by the Track E screens (Exposure, Investigate, Reports, Integrations,
 * Settings): cards, keyboard-accessible tabs, a segmented control, a select and an inline alert.
 * Everything renders untrusted values as React text only.
 */
import { useId, useRef, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Card({ title, description, action, children, className, bodyClassName, labelledBy }: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  labelledBy?: string;
}) {
  const id = useId();
  const headingId = labelledBy ?? `${id}-h`;
  return (
    <section aria-labelledby={title ? headingId : undefined} className={cn('overflow-hidden rounded-lg border bg-card text-card-foreground', className)}>
      {(title || action) && (
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2 border-b px-4 py-3">
          <div className="flex min-w-0 grow flex-col gap-0.5">
            {title && (
              <h2 id={headingId} className="m-0 text-sm font-semibold leading-5">
                {title}
              </h2>
            )}
            {description && <p className="m-0 text-[13px] leading-[18px] text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="flex flex-wrap items-center gap-1.5">{action}</div>}
        </div>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export interface TabItem<K extends string> {
  id: K;
  label: ReactNode;
  disabled?: boolean;
}

/**
 * WAI-ARIA tabs: arrow keys, Home and End move between tabs (automatic activation). The
 * caller renders the panel; pass `panelId(id)` as the panel's id and `tabId(id)` as its
 * aria-labelledby.
 */
export function Tabs<K extends string>({ items, value, onChange, label, idBase, variant = 'line', className }: {
  items: TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  label: string;
  idBase: string;
  variant?: 'line' | 'pill';
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const enabled = items.filter((i) => !i.disabled);
  const onKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const idx = enabled.findIndex((i) => i.id === value);
    let next: TabItem<K> | undefined;
    if (e.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (e.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (e.key === 'Home') next = enabled[0];
    else if (e.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    e.preventDefault();
    onChange(next.id);
    refs.current[next.id]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        'flex flex-wrap items-center',
        variant === 'line' ? 'gap-4' : 'w-fit gap-0.5 rounded-lg bg-muted p-[3px]',
        className,
      )}
    >
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={tabId(idBase, t.id)}
            aria-selected={on}
            aria-controls={panelId(idBase, t.id)}
            tabIndex={on ? 0 : -1}
            disabled={t.disabled}
            onClick={() => onChange(t.id)}
            onKeyDown={onKey}
            className={cn(
              'cursor-pointer whitespace-nowrap border-0 bg-transparent font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default disabled:opacity-50',
              variant === 'line'
                ? cn('-mb-px border-b-2 px-0.5 py-2 text-[13px]', on ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')
                : cn('h-7 rounded-md px-2.5 text-[13px]', on ? 'bg-background text-foreground shadow-[var(--shadow-xs)]' : 'text-muted-foreground hover:text-foreground'),
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const tabId = (base: string, id: string) => `${base}-tab-${id}`;
export const panelId = (base: string, id: string) => `${base}-panel-${id}`;

export function TabPanel({ idBase, id, children, className }: { idBase: string; id: string; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={panelId(idBase, id)} aria-labelledby={tabId(idBase, id)} className={className}>
      {children}
    </div>
  );
}

export function Select({ label, className, children, hideLabel, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hideLabel?: boolean }) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1.5">
      <label htmlFor={id} className={cn('text-[13px] text-muted-foreground', hideLabel && 'sr-only')}>
        {label}
      </label>
      <select
        id={id}
        className={cn(
          'h-8 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
          className,
        )}
        {...rest}
      >
        {children}
      </select>
    </span>
  );
}

export function InlineAlert({ children, tone = 'error', onDismiss }: { children: ReactNode; tone?: 'error' | 'info' | 'success'; onDismiss?: () => void }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-[13px] leading-[18px]',
        tone === 'error' && 'border-destructive/40 text-destructive',
        tone === 'success' && 'border-success/40 text-success',
        tone === 'info' && 'text-muted-foreground',
      )}
    >
      <span className="grow">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss" className="cursor-pointer border-0 bg-transparent p-0 text-inherit">
          ×
        </button>
      )}
    </div>
  );
}

/** "coming soon" marker for features that are not implemented in 4a. */
export function ComingSoon({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-xs font-medium leading-4 text-muted-foreground', className)}>
      Coming soon
    </span>
  );
}

export const inputClass =
  'h-8 rounded-md border border-input bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50';

/** Error message from an unknown thrown value. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shorten a hash for display (`3f9a0c…c21e`). */
export function shortHash(h: string, head = 8, tail = 4): string {
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

/** Only http(s) URLs become links; anything else is shown as text. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}
