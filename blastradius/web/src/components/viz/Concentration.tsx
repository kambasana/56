/**
 * Publishing-account concentration (docs/ACCOUNT-PROOF.md H3): which npm accounts can publish the
 * largest share of production dependencies, org-wide and per project. A bar list (ink bars: these
 * are production packages, and colour stays reserved for severity) with a Table view, which is the
 * accessible equivalent. Every account opens its Account page. Data: GET /api/accounts/concentration.
 */
import { Link } from 'react-router';
import type { ConcentrationAccount, ConcentrationResponse } from '@server/api-types-accounts';
import { accountPath } from '@/nav';
import { useViewParam, ViewToggle } from './ViewToggle';

export const pct = (share: number) => `${Math.round(share * 1000) / 10}%`;

function Bars({ accounts, of, label }: { accounts: readonly ConcentrationAccount[]; of: number; label: string }) {
  const max = Math.max(0.0001, ...accounts.map((a) => a.share));
  const summary = accounts.length
    ? `${label}: ${accounts
        .slice(0, 3)
        .map((a) => `${a.name} can publish ${pct(a.share)}`)
        .join(', ')} of ${of} production packages with registry data.`
    : `${label}: no account data yet.`;
  return (
    <figure className="m-0 flex flex-col gap-1.5" aria-label={summary}>
      <figcaption className="text-label font-medium">{label}</figcaption>
      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        {accounts.map((a) => (
          <li key={a.name} className="grid grid-cols-[minmax(7rem,11rem)_minmax(0,1fr)_auto] items-center gap-2">
            <Link to={accountPath('npm', a.name)} className="truncate font-mono text-[12px]" title={a.name}>
              {a.name}
            </Link>
            <span aria-hidden="true" className="h-2.5 rounded-[3px] bg-muted">
              <span className="block h-full rounded-[3px] bg-reach-prod" style={{ width: `${(a.share / max) * 100}%` }} />
            </span>
            <span className="text-right text-label tabular-nums text-text-secondary">
              {pct(a.share)} · {a.packages}
            </span>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function ConcentrationTable({ data }: { data: ConcentrationResponse }) {
  const rows = [
    ...data.org.accounts.map((a) => ({ scope: 'All projects', of: data.org.withData, a })),
    ...data.projects.flatMap((p) => p.accounts.map((a) => ({ scope: p.projectName, of: p.withData, a }))),
  ];
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table aria-label="Publishing accounts" className="w-full border-collapse text-left">
        <thead>
          <tr className="bg-muted text-label text-text-secondary">
            <th scope="col" className="px-3 py-2 font-medium">Scope</th>
            <th scope="col" className="px-2 py-2 font-medium">Account</th>
            <th scope="col" className="px-2 py-2 font-medium">Production packages it can publish</th>
            <th scope="col" className="px-3 py-2 font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ scope, of, a }) => (
            <tr key={`${scope} ${a.name}`} className="border-t">
              <td className="px-3 py-2">{scope}</td>
              <td className="px-2 py-2 font-mono text-[12px]">
                <Link to={accountPath('npm', a.name)}>{a.name}</Link>
              </td>
              <td className="px-2 py-2 tabular-nums">
                {a.packages} of {of}
                {a.projects !== undefined ? ` · in ${a.projects} ${a.projects === 1 ? 'project' : 'projects'}` : ''}
              </td>
              <td className="px-3 py-2 tabular-nums">{pct(a.share)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The section: org-wide bars, the top account per project, and a Chart/Table toggle (`cview=`). */
export function ConcentrationSection({ data }: { data: ConcentrationResponse }) {
  const [view, setView] = useViewParam(['chart', 'table'] as const, 'chart', 'cview');
  const missing = data.org.productionPackages - data.org.withData;
  return (
    <section aria-labelledby="concentration" className="flex flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="concentration" className="m-0 text-heading font-semibold">
          Who can publish your production dependencies
        </h2>
        <ViewToggle value={view} onChange={setView} label="Concentration view" options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
      </div>
      <p className="m-0 text-text-secondary">
        If one of these npm accounts is taken over, every package it can publish is at risk. Shares are of {data.org.withData} production packages with registry data
        {missing > 0 ? ` (${missing} more have none yet)` : ''}.
      </p>
      {data.org.accounts.length === 0 ? (
        <p className="m-0 text-label text-text-secondary">No registry data yet. It is fetched after each scan.</p>
      ) : view === 'chart' ? (
        <div className="grid gap-6 lg:grid-cols-2">
          <Bars accounts={data.org.accounts} of={data.org.withData} label="All projects" />
          <div className="flex flex-col gap-1.5">
            <span className="text-label font-medium">Top account per project</span>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {data.projects.map((p) => {
                const top = p.accounts[0];
                return (
                  <li key={p.projectId} className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="truncate">{p.projectName}</span>
                    {top ? (
                      <span className="text-label text-text-secondary">
                        <Link to={accountPath('npm', top.name)} className="font-mono text-[12px]">
                          {top.name}
                        </Link>{' '}
                        {pct(top.share)} of {p.withData}
                      </span>
                    ) : (
                      <span className="text-label text-text-secondary">No registry data yet</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      ) : (
        <ConcentrationTable data={data} />
      )}
    </section>
  );
}
