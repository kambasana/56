/**
 * Maintenance signals (noise rule, docs/DATA-ML.md): components whose only reasons are posture
 * signals such as no provenance or a single maintainer. Shown beside findings, never counted
 * as risk, so the Findings table stays about things that happened or are known to be bad.
 */
import type { HealthItem } from '@server/api-types';
import { DataTable, type ColumnDef } from '@/components/DataTable';
import { factorLabel } from './format';

const COLUMNS: ColumnDef<HealthItem, any>[] = [
  {
    id: 'component',
    header: 'Component',
    accessorFn: (r) => r.name,
    cell: (c) => <span className="font-mono text-xs">{c.row.original.name}</span>,
    size: 260,
  },
  { id: 'version', header: 'Version', accessorFn: (r) => r.version, cell: (c) => <span className="font-mono text-xs">{c.getValue<string>()}</span>, size: 110 },
  {
    id: 'signals',
    header: 'Maintenance',
    accessorFn: (r) => r.signals.map((s) => factorLabel(s.factor)).join(', '),
    cell: (c) => (
      <span className="text-muted-foreground" title={c.row.original.signals.map((s) => s.detail).join('\n')}>
        {c.getValue<string>()}
      </span>
    ),
    size: 420,
  },
  { id: 'purl', header: 'Purl', accessorFn: (r) => r.purl },
];

export function HealthTable({ items, loading }: { items: HealthItem[]; loading: boolean }) {
  return (
    <DataTable<HealthItem>
      label="Maintenance"
      data={items}
      loading={loading}
      columns={COLUMNS}
      getRowId={(r) => r.purl}
      filterPlaceholder="Filter by name or signal…"
      initialColumnVisibility={{ purl: false }}
      total={items.length}
      emptyTitle="No maintenance-only signals"
      emptyDescription="Every component with a signal in this scan is in Findings."
    />
  );
}
