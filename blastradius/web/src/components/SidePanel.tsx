import { useEffect, useRef, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SidePanelProps {
  title: ReactNode;
  /** Small line above the title (badges, ecosystem, first seen). */
  eyebrow?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  className?: string;
  /** Accessible label for the region. */
  label?: string;
}

/**
 * Right-hand detail panel (Findings, Changes, ...). It sits beside the table, not over it,
 * matching the canvas split layout. Escape closes it.
 */
export function SidePanel({ title, eyebrow, actions, onClose, children, className, label = 'Details' }: SidePanelProps) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <aside
      ref={ref}
      aria-label={label}
      className={cn('flex min-w-0 flex-[1_1_400px] flex-col border-l bg-background lg:max-w-[520px]', className)}
    >
      <div className="flex flex-col gap-1.5 border-b px-4 py-3.5">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 grow flex-col gap-1.5">
            {eyebrow && <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{eyebrow}</div>}
            <h2 className="m-0 break-words font-mono text-[15px] font-semibold leading-[22px]">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="size-7 shrink-0 cursor-pointer rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ×
          </button>
        </div>
        {actions && <div className="flex flex-wrap gap-1.5 pt-0.5">{actions}</div>}
      </div>
      <div className="min-h-0 grow overflow-auto px-4 py-3 text-[13px] leading-[18px]">{children}</div>
    </aside>
  );
}
