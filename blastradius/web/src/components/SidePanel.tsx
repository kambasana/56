import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { Sheet, SheetClose, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export interface SidePanelProps {
  title: ReactNode;
  /** Small line above the title (badges, ecosystem, first seen). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
  /** Accessible label of the panel region. */
  label?: string;
}

/**
 * Right-hand detail panel (Findings, Changes, Scans, Investigate): a shadcn Sheet (side=right,
 * wide). It is non-modal so the table behind it stays usable (arrow keys, clicking another
 * row) and opening it does not move focus; Escape or the close button dismisses it. Mounted = open: callers render it only
 * while something is selected.
 */
export function SidePanel({ title, eyebrow, actions, onClose, children, className, label = 'Details' }: SidePanelProps) {
  return (
    <Sheet open modal={false} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        showCloseButton={false}
        aria-describedby={undefined}
        onInteractOutside={(e) => e.preventDefault()}
        // Keep focus where it is (the table row, a graph tab): the panel follows the selection.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        className={cn('w-full gap-0 p-0 sm:max-w-xl', className)}
      >
        <aside aria-label={label} className="flex min-h-0 flex-1 flex-col">
          <SheetHeader className="gap-1.5 border-b p-4">
            <div className="flex items-start gap-2">
              <div className="flex min-w-0 grow flex-col gap-1.5">
                {eyebrow && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{eyebrow}</div>}
                <SheetTitle className="font-mono text-base break-words">{title}</SheetTitle>
              </div>
              <SheetClose asChild>
                <Button type="button" variant="ghost" size="icon-sm" aria-label="Close panel" className="-mt-1 -mr-1 shrink-0">
                  <XIcon />
                </Button>
              </SheetClose>
            </div>
            {actions && <div className="flex flex-wrap gap-1.5 pt-1">{actions}</div>}
          </SheetHeader>
          <ScrollArea className="min-h-0 flex-1">
            <div className="px-4 py-3 text-sm">{children}</div>
          </ScrollArea>
        </aside>
      </SheetContent>
    </Sheet>
  );
}
