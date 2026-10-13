/**
 * Dev-only "view as" switcher (`blastradius serve --dev`). It lives in the top bar, outside the
 * product menus, and renders nothing unless the server runs in dev mode.
 */
import { FlaskConical } from 'lucide-react';
import type { MeResponse } from '@server/api-types';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

export function DevViewAs({ me, onSwitchUser }: { me: MeResponse; onSwitchUser?: (userId: string) => void }) {
  if (!me.devMode || !me.devUsers?.length || !onSwitchUser) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="dev-view-as" className="h-7 gap-1.5 border-dashed border-warning px-2 text-label text-warning hover:text-warning">
          <FlaskConical aria-hidden="true" className="size-3.5" />
          Dev: view as
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-64">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Dev mode only: sign in as a seeded user</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={me.user.id} onValueChange={(id) => id !== me.user.id && onSwitchUser(id)} aria-label="Dev: view as">
          {me.devUsers.map((u) => (
            <DropdownMenuRadioItem key={u.id} value={u.id}>
              <span className="truncate">
                {u.email} <span className="text-muted-foreground">({u.roles.join(', ') || 'no role'})</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
