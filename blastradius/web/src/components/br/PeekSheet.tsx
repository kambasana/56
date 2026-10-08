/**
 * PeekSheet: triage a row without leaving the list. The open row id lives in the URL
 * (`?peek=<id>` by default), so the sheet has a link, opening it pushes history and Back closes
 * it. Moving with J/K replaces the entry (Back still returns to the list, not the previous row).
 */
import { useCallback, useEffect, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export const PEEK_PARAM = 'peek';

interface PeekState {
  /** Set on the history entry that opening the sheet pushed. */
  brPeek?: true;
}

export interface UsePeek {
  /** The open row id, or null. */
  id: string | null;
  /** Open a row: pushes a history entry (or replaces when already open, e.g. J/K). */
  open: (id: string) => void;
  /** Close: goes Back when this sheet pushed the entry, else drops the param in place. */
  close: () => void;
}

export function usePeek(param: string = PEEK_PARAM): UsePeek {
  const [sp] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const id = sp.get(param);
  const pushed = (location.state as PeekState | null)?.brPeek === true;

  const open = useCallback(
    (next: string) => {
      const q = new URLSearchParams(sp);
      q.set(param, next);
      const already = q.toString() === sp.toString();
      if (already) return;
      navigate({ search: `?${q}` }, { replace: id !== null, state: id !== null ? location.state : ({ brPeek: true } satisfies PeekState) });
    },
    [sp, param, id, navigate, location.state],
  );

  const close = useCallback(() => {
    if (id === null) return;
    if (pushed) {
      navigate(-1);
      return;
    }
    const q = new URLSearchParams(sp);
    q.delete(param);
    const s = q.toString();
    navigate({ search: s ? `?${s}` : '' }, { replace: true });
  }, [id, pushed, navigate, sp, param]);

  return { id, open, close };
}

function typingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('[role=combobox],[role=listbox],[role=menu]') !== null;
}

/**
 * J (next) and K (previous) through `ids` from `current`. Ignored while typing or with a modifier.
 * Does nothing when `enabled` is false or `current` is not in `ids`.
 */
export function useJK({ ids, current, onMove, enabled = true }: { ids: readonly string[]; current: string | null; onMove: (id: string) => void; enabled?: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target)) return;
      const k = e.key.toLowerCase();
      if (k !== 'j' && k !== 'k') return;
      const i = current === null ? -1 : ids.indexOf(current);
      if (i < 0) return;
      const next = ids[k === 'j' ? i + 1 : i - 1];
      if (next === undefined) return;
      e.preventDefault();
      onMove(next);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ids, current, onMove, enabled]);
}

export interface PeekSheetProps {
  /** Usually `peek.id !== null`. */
  open: boolean;
  onClose: () => void;
  /** e.g. <SeverityBadge/> and the package@version. */
  title: ReactNode;
  /** One line under the title ("Malicious release"). */
  description?: ReactNode;
  /** The Detail page with its own URL ("Open full page"). */
  fullPageHref?: string;
  /** Extra footer controls next to "Open full page" (status, owner). */
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function PeekSheet({ open, onClose, title, description, fullPageHref, footer, children, className }: PeekSheetProps) {
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent
        side="right"
        data-slot="peek-sheet"
        className={cn('w-full gap-3 bg-popover p-5 shadow-elev-2 duration-150 data-[state=closed]:duration-150 data-[state=open]:duration-150 sm:max-w-[var(--sheet-w)]', className)}
      >
        <SheetHeader className="gap-1 p-0 pr-8">
          <SheetTitle className="flex flex-col items-start gap-1.5 text-heading">{title}</SheetTitle>
          {description ? <SheetDescription className="text-body text-text-secondary">{description}</SheetDescription> : <SheetDescription className="sr-only">Details</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        <SheetFooter className="flex-row flex-wrap items-center gap-2 p-0">
          {fullPageHref && (
            <Link to={fullPageHref} data-slot="button" className="inline-flex h-7 items-center rounded-lg bg-primary px-3 text-label font-medium text-primary-foreground hover:bg-primary/90">
              Open full page
            </Link>
          )}
          {footer}
          <span className="text-caption text-muted-foreground">J / K for next and previous</span>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
