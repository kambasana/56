import type { ReactNode } from 'react';
import { Link } from 'react-router';

export interface Crumb {
  label: ReactNode;
  to?: string;
}

export interface PageHeaderProps {
  /** Breadcrumb trail; the last item is the current page. */
  crumbs?: Crumb[];
  title: ReactNode;
  /** Muted mono line next to the title, e.g. "1,284 open · scan 02:14 UTC". */
  meta?: ReactNode;
  /** Right side of the top bar (search, export, primary action). */
  actions?: ReactNode;
  /** Right side of the title row (tabs, group-by, ...). */
  children?: ReactNode;
}

/** Top bar (breadcrumb + actions, 52px) and title row, as on every canvas screen. */
export function PageHeader({ crumbs, title, meta, actions, children }: PageHeaderProps) {
  return (
    <div className="border-b">
      <header className="flex min-h-[52px] flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-1.5">
        <nav aria-label="Breadcrumb" className="min-w-0">
          <ol className="m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[13px] text-muted-foreground">
            {(crumbs ?? []).map((c, i, all) => {
              const last = i === all.length - 1;
              return (
                <li key={i} className="flex items-center gap-1.5">
                  {c.to && !last ? (
                    <Link to={c.to} className="text-muted-foreground no-underline hover:text-foreground">
                      {c.label}
                    </Link>
                  ) : (
                    <span aria-current={last ? 'page' : undefined} className={last ? 'text-foreground' : undefined}>
                      {c.label}
                    </span>
                  )}
                  {!last && <span aria-hidden="true">/</span>}
                </li>
              );
            })}
          </ol>
        </nav>
        <span className="grow" />
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-5 py-2 text-[13px] leading-[18px]">
        <h1 className="m-0 mr-1.5 text-[15px] font-semibold leading-[22px]">{title}</h1>
        {meta && <span className="font-mono text-muted-foreground">{meta}</span>}
        <span className="grow" />
        {children}
      </div>
    </div>
  );
}
