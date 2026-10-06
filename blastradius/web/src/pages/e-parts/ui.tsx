/**
 * Shared pieces for the Track E screens (Exposure, Investigate, Reports, Integrations, Settings),
 * composed only from the shadcn/ui components in @/components/ui. Untrusted values are
 * rendered as React text only.
 */
import { useId, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CheckIcon, CircleAlert, CircleCheck, CopyIcon, XIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/**
 * A titled shadcn Card used as a page section. It is a labelled region (h2 title), with an
 * optional action area (CardAction) and an edge-to-edge body for tables.
 */
export function SectionCard({ title, description, action, children, className, contentClassName }: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  const id = useId();
  return (
    <Card role={title ? 'region' : undefined} aria-labelledby={title ? id : undefined} className={cn('gap-0 overflow-hidden py-0', className)}>
      {(title || action) && (
        <CardHeader className="gap-1 border-b px-4 py-3 [.border-b]:pb-3">
          {title && (
            <CardTitle>
              <h2 id={id} className="flex items-center gap-2 text-sm leading-5 font-semibold">
                {title}
              </h2>
            </CardTitle>
          )}
          {description && <CardDescription className="text-[13px] leading-[18px]">{description}</CardDescription>}
          {action && <CardAction className="flex flex-wrap items-center gap-1.5">{action}</CardAction>}
        </CardHeader>
      )}
      <CardContent className={cn('px-0', contentClassName)}>{children}</CardContent>
    </Card>
  );
}

export interface Option {
  value: string;
  label: ReactNode;
}

/**
 * Labelled shadcn Select (Radix). Radix forbids an empty item value, so callers use a
 * sentinel such as "all" for "no filter".
 */
export function LabeledSelect({ label, value, onValueChange, options, hideLabel, placeholder, disabled, className, size = 'sm' }: {
  label: string;
  value: string;
  onValueChange: (v: string) => void;
  options: Option[];
  hideLabel?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: 'sm' | 'default';
}) {
  const id = useId();
  return (
    <span className="inline-flex items-center gap-1.5">
      <Label htmlFor={id} className={cn('text-[13px] font-normal text-muted-foreground', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} size={size} className={cn('min-w-[120px] text-[13px]', className)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </span>
  );
}

/** Inline error (destructive Alert). Success messages go to toasts instead. */
export function ErrorAlert({ title, children, onDismiss, className }: { title?: ReactNode; children: ReactNode; onDismiss?: () => void; className?: string }) {
  return (
    <Alert variant="destructive" className={cn('py-2', onDismiss && 'pr-10', className)}>
      <CircleAlert />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
      {onDismiss && (
        <Button type="button" variant="ghost" size="icon-xs" onClick={onDismiss} aria-label="Dismiss" className="absolute top-2 right-2">
          <XIcon />
        </Button>
      )}
    </Alert>
  );
}

/** Neutral note (default Alert). */
export function NoteAlert({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Alert role="note" className={cn('py-2', className)}>
      <CircleCheck />
      {title && <AlertTitle>{title}</AlertTitle>}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** "Coming soon" marker for features that are not implemented in 4a. */
export function ComingSoon({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={cn('text-muted-foreground', className)}>
      Coming soon
    </Badge>
  );
}

/** Copy a value to the clipboard, with a toast and a check-mark for feedback. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      toast.success('Copied to the clipboard');
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error('Could not copy. Select the text and copy it by hand.');
    }
  };
  return (
    <Button type="button" variant="outline" size="icon-sm" onClick={copy} aria-label={label}>
      {done ? <CheckIcon /> : <CopyIcon />}
    </Button>
  );
}

/**
 * A button that asks for confirmation in a shadcn AlertDialog before running a destructive
 * action. Focus starts on Cancel (Radix default for AlertDialog).
 */
export function ConfirmButton({ children, title, description, confirmLabel, onConfirm, disabled, ariaLabel, variant = 'ghost', destructive = true }: {
  children: ReactNode;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  variant?: 'ghost' | 'outline';
  destructive?: boolean;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" size="xs" variant={variant} disabled={disabled} aria-label={ariaLabel}>
          {children}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Error message from an unknown thrown value. */
export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Shorten a hash for display (`3f9a0c…c21e`). */
export function shortHash(h: string, head = 8, tail = 4): string {
  return h.length <= head + tail + 1 ? h : `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export { safeHref } from '@/lib/safe-href';
