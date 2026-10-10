import { Fragment, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { useShellHeader } from './shell-header';

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

/**
 * Every crumb is a link (docs/UX.md §2). The last one is the current page (aria-current), and a
 * crumb without `to` links to the current address.
 */
function Crumbs({ crumbs }: { crumbs: Crumb[] }) {
  const { pathname, search } = useLocation();
  const here = pathname + search;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={i}>
              <BreadcrumbItem className={last ? 'min-w-0' : 'hidden md:inline-flex'}>
                <BreadcrumbLink asChild className={last ? 'truncate font-normal text-foreground' : undefined}>
                  <Link to={last ? here : (c.to ?? here)} aria-current={last ? 'page' : undefined}>
                    {c.label}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator className="hidden md:block" />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function TopBar({ crumbs, actions }: { crumbs: Crumb[]; actions?: ReactNode }) {
  return (
    <>
      <Crumbs crumbs={crumbs} />
      <span className="grow" />
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </>
  );
}

/**
 * Page header: breadcrumb + actions in the shell's top bar (next to the sidebar trigger),
 * then the title row (h1, meta, extra controls) at the top of the page.
 */
export function PageHeader({ crumbs, title, meta, actions, children }: PageHeaderProps) {
  const shell = useShellHeader();
  const trail = crumbs ?? [];
  const top = <TopBar crumbs={trail} actions={actions} />;
  return (
    <div data-slot="page-header" className="border-b">
      {shell ? (
        shell.slot && createPortal(top, shell.slot)
      ) : (
        <header className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-1.5">{top}</header>
      )}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-3">
        <h1 className="mr-1.5 text-lg font-semibold tracking-tight">{title}</h1>
        {meta && <span className="font-mono text-xs text-muted-foreground">{meta}</span>}
        <span className="grow" />
        {children}
      </div>
    </div>
  );
}
