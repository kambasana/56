/**
 * Settings and session features, serially, as real users through the real UI:
 *  - invite a member in the Invite dialog, then sign in as them in a fresh browser context;
 *  - a second organization: invite an existing account by link, accept it in a fresh context,
 *    then switch organizations with the org switcher (nav must follow each org's roles);
 *  - a custom role made from a template in the permission matrix; toggling a page on and off
 *    changes that user's nav, direct URL (403 state) and API (403);
 *  - bindings: assign a project-scoped role in the Bindings tab, it takes effect, remove it;
 *  - finding status review from the Finding page;
 *  - the audit log lists every one of those actions;
 *  - theme toggle persists across reloads and pages, System follows the OS;
 *  - sign out ends only that session.
 * Sign-ins are rate limited (10 per address, 50 per IP per 15 min), so this file signs in
 * as few times as it can.
 */
import { randomBytes } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { settle, watch } from './lib/checks';
import { BASE_URL, readState, userFor } from './lib/env';
import { api, Check, DESKTOP, getJson, rolePage, scannedProjects } from './lib/feature';

const XRW = { 'X-Requested-With': 'blastradius' };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function freshPage(browser: Browser, colorScheme: 'light' | 'dark' = 'light'): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: DESKTOP.width, height: DESKTOP.height }, colorScheme });
  return ctx.newPage();
}

async function uiSignIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Let the landing page finish loading (as a person would) before using the menus. No retries:
  // a menu that then ignores a click is still a failure.
  await settle(page);
}

async function navLabels(page: Page): Promise<string[]> {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await nav.waitFor();
  return (await nav.locator('a[href]').allInnerTexts()).map((s) => s.trim());
}

/** State shared between the serial tests below. */
const shared: { leadEmail?: string; leadPassword?: string; leadUserId?: string; roleId?: string; roleName?: string; bindingId?: string } = {};

test('invite a member in the dialog and sign in as them in a new context', async ({ browser }) => {
  const state = readState();
  const c = new Check('settings invite (UI)', 'admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  const email = `hammer-ui-${state.runId}@hammer.test`;
  let secret = '';
  let kind = '';
  await c.step('invite dialog', async () => {
    await page.goto('/settings');
    await settle(page);
    await page.getByRole('button', { name: 'Invite member' }).click();
    const dlg = page.getByRole('dialog', { name: 'Invite member' });
    await dlg.getByLabel('Email').fill(email);
    await dlg.getByLabel('Name').fill('Hammer UI Invitee');
    await dlg.getByRole('combobox', { name: 'Role' }).click();
    await page.getByRole('option', { name: 'Developer', exact: true }).click();
    await c.snap(page, 'dialog');
    await dlg.getByRole('button', { name: 'Send invite' }).click();
    const done = page.getByRole('dialog', { name: /Member invited|Invite created/ });
    await expect(done).toBeVisible();
    kind = (await done.getByRole('heading').first().innerText()).trim();
    const box = done.getByRole('textbox', { name: /One-time password|Invite link/ });
    secret = await box.inputValue();
    await c.snap(page, 'result');
    await done.getByRole('button', { name: 'Done' }).click();
    // Dev mode creates the member at once; otherwise they join when they accept the link.
    if (kind === 'Member invited') await expect(page.getByRole('table', { name: 'Members' })).toContainText(email);
    else await expect(page.getByRole('table', { name: 'Members' })).not.toContainText(email);
  });
  await c.step('accept in a new context', async () => {
    if (!secret) throw new Error('no one-time password or invite link was shown');
    const p2 = await freshPage(browser);
    if (kind === 'Member invited') {
      await uiSignIn(p2, email, secret);
    } else {
      await p2.goto(secret);
      await p2.getByLabel('Password').fill(randomBytes(16).toString('base64url'));
      await p2.getByRole('button', { name: 'Accept invite' }).click();
      await expect(p2.getByRole('navigation', { name: 'Main' })).toBeVisible();
    }
    await expect(p2.getByTestId('nav-role')).toContainText('Developer');
    const labels = await navLabels(p2);
    if (labels.includes('Settings')) c.fail('invited Developer sees Settings');
    await p2.context().close();
    await page.reload();
    await settle(page);
    await expect(page.getByRole('table', { name: 'Members' })).toContainText(email);
  });
  c.facts.flow = kind;
  await close();
  c.done(w);
});

test('second org: invite an existing account by link, accept it, switch orgs', async ({ browser }) => {
  const state = readState();
  const c = new Check('org invite link + org switcher', 'developer');
  const admin = userFor('admin');
  const dev = userFor('developer');
  // A separate admin session: creating an org moves that session into the new org.
  const adminB: APIRequestContext = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: XRW });
  const orgName = `Hammer Org B ${state.runId}`;
  let token = '';
  await c.step('create org B and invite the developer', async () => {
    const login = await adminB.post('/api/auth/login', { data: { email: admin.email, password: admin.password } });
    if (!login.ok()) throw new Error(`admin sign-in: HTTP ${login.status()}`);
    const org = await adminB.post('/api/orgs', { data: { name: orgName } });
    if (org.status() !== 201) throw new Error(`create org: HTTP ${org.status()} ${await org.text()}`);
    const inv = await adminB.post('/api/members', { data: { email: dev.email, name: 'ignored for existing accounts', bindings: [{ roleId: 'auditor', scope: { kind: 'org' } }] } });
    if (inv.status() !== 201) throw new Error(`invite: HTTP ${inv.status()} ${await inv.text()}`);
    const body = (await inv.json()) as { invite?: { token: string }; member?: unknown };
    if (!body.invite) throw new Error('inviting an existing account did not return an invite link');
    token = body.invite.token;
  });
  await adminB.dispose();
  const page = await freshPage(browser);
  const w = watch(page);
  w.allow401(/^\/api\/me/);
  await c.step('accept the link in a new context', async () => {
    await page.goto(`/accept-invite#token=${token}`);
    await expect(page.getByRole('heading', { name: 'Accept your invite' })).toBeVisible();
    await c.snap(page, 'accept');
    await page.getByLabel('Password').fill(dev.password);
    await page.getByRole('button', { name: 'Accept invite' }).click();
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });
  await c.step('org switcher lists both orgs and switches', async () => {
    const switcher = page.getByRole('button', { name: /^Organization: .+\. Switch organization$/ });
    await switcher.click();
    const menu = page.getByRole('menu');
    await expect(menu).toContainText(orgName);
    await expect(menu).toContainText(state.orgName);
    await c.snap(page, 'switcher');
    const current = (await page.getByTestId('nav-org').innerText()).trim();
    const other = current === orgName ? state.orgName : orgName;
    // Match the org name exactly: "Hammer" is a prefix of "Hammer Org B …", so a substring match is ambiguous.
    const item = (name: string) => page.getByRole('menu').locator('[role=menuitem], [role=menuitemradio]').filter({ has: page.getByText(name, { exact: true }) });
    await item(other).click();
    await expect(page.getByText(`Switched to ${other}`)).toBeVisible();
    await expect(page.getByTestId('nav-org')).toHaveText(other);
    const labelsA = await navLabels(page);
    // Org B: Auditor (Reports only). Org A: Developer (every page but Settings).
    if (other === orgName && labelsA.join() !== 'Reports') c.fail(`in org B (Auditor) the nav shows ${labelsA.join(', ')}`);
    if (other === state.orgName && !labelsA.includes('Home')) c.fail(`in org A (Developer) the nav lacks Home: ${labelsA.join(', ')}`);
    // And back.
    await switcher.click();
    await item(current).click();
    await expect(page.getByTestId('nav-org')).toHaveText(current);
    await c.snap(page, 'switched-back');
  });
  await page.context().close();
  c.done(w);
});

async function rolesMatrix(browser: Browser): Promise<void> {
  const state = readState();
  const c = new Check('roles matrix takes effect', 'admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  const ctx = await api('admin');
  const roleName = `Hammer Lead ${state.runId}`;
  const project = scannedProjects()[0]!;
  shared.roleName = roleName;
  await c.step('create role from the Auditor template', async () => {
    await page.goto('/settings?tab=roles');
    await settle(page);
    const form = page.getByRole('form', { name: 'New role from template' });
    await form.getByLabel('New role').fill(roleName);
    await form.getByRole('combobox', { name: 'from template' }).click();
    await page.getByRole('option', { name: 'Auditor', exact: true }).click();
    await form.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByRole('checkbox', { name: `${roleName}: Reports` })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: `${roleName}: Findings` })).not.toBeChecked();
    const roles = await getJson<{ items: { id: string; name: string }[] }>(ctx, '/api/roles');
    shared.roleId = roles.items.find((r) => r.name === roleName)?.id;
    if (!shared.roleId) throw new Error('role not in /api/roles');
  });
  await c.step('grant Home + Findings and save', async () => {
    await page.getByRole('checkbox', { name: `${roleName}: Home` }).check();
    await page.getByRole('checkbox', { name: `${roleName}: Findings` }).check();
    // "N unsaved" counts roles with pending edits.
    await expect(page.getByText('1 unsaved')).toBeVisible();
    await c.snap(page, 'unsaved');
    await page.getByRole('button', { name: 'Save roles' }).click();
    await expect(page.getByText(/unsaved/)).toHaveCount(0);
    const roles = await getJson<{ items: { id: string; permissions: string[] }[] }>(ctx, '/api/roles');
    const perms = roles.items.find((r) => r.id === shared.roleId)?.permissions ?? [];
    for (const p of ['home', 'findings', 'reports']) if (!perms.includes(p)) c.fail(`after save the role lacks ${p}: ${perms.join(',')}`);
  });
  // A user holding only this role.
  const email = `hammer-lead-${state.runId}@hammer.test`;
  const leadPage = await freshPage(browser);
  await c.step('invite a user with the role and sign in', async () => {
    const res = await ctx.post('/api/members', { data: { email, name: 'Hammer Lead', bindings: [{ roleId: shared.roleId, scope: { kind: 'org' } }] } });
    if (res.status() !== 201) throw new Error(`invite: HTTP ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { member?: { id: string }; oneTimePassword?: string; invite?: { token: string } };
    if (body.oneTimePassword && body.member) {
      shared.leadPassword = body.oneTimePassword;
      shared.leadUserId = body.member.id;
      await uiSignIn(leadPage, email, body.oneTimePassword);
    } else if (body.invite) {
      shared.leadPassword = randomBytes(16).toString('base64url');
      await leadPage.goto(`/accept-invite#token=${body.invite.token}`);
      await leadPage.getByLabel('Password').fill(shared.leadPassword);
      await leadPage.getByRole('button', { name: 'Accept invite' }).click();
      await expect(leadPage.getByRole('navigation', { name: 'Main' })).toBeVisible();
    }
    shared.leadEmail = email;
    await leadPage.goto(`/projects/${encodeURIComponent(project.id)}/findings`);
    await settle(leadPage);
    const labels = await navLabels(leadPage);
    for (const l of ['Home', 'Reports', 'Findings']) if (!labels.includes(l)) c.fail(`lead nav lacks ${l}: ${labels.join(', ')}`);
    for (const l of ['Settings', 'Scans', 'Investigate']) if (labels.includes(l)) c.fail(`lead nav shows ${l}`);
    if (await leadPage.getByText("You don't have access to this page").count()) c.fail('lead sees the 403 state on Findings after the grant');
    await c.snap(leadPage, 'lead-granted');
  });
  await c.step('revoke Findings: nav, route and API follow', async () => {
    await page.reload();
    await settle(page);
    await page.getByRole('checkbox', { name: `${roleName}: Findings` }).uncheck();
    await expect(page.getByText('1 unsaved')).toBeVisible();
    await page.getByRole('button', { name: 'Save roles' }).click();
    await expect(page.getByText(/unsaved/)).toHaveCount(0);
    await leadPage.reload();
    await settle(leadPage);
    const labels = await navLabels(leadPage);
    if (labels.includes('Findings')) c.fail(`after revoking, lead nav still shows Findings`);
    await expect(leadPage.getByText("You don't have access to this page")).toBeVisible();
    const r = await leadPage.request.get(`/api/findings?project=${encodeURIComponent(project.id)}`);
    if (r.status() !== 403) c.fail(`after revoking, GET /api/findings answers ${r.status()} for the lead`);
    await c.snap(leadPage, 'lead-revoked');
  });
  await leadPage.context().close();
  await ctx.dispose();
  await close();
  c.done(w);
}

async function bindingsTab(browser: Browser): Promise<void> {
  const c = new Check('bindings assign/remove', 'admin');
  if (!shared.leadEmail) {
    c.fail('needs the lead user from the previous test');
    c.done();
    return;
  }
  const { page, w, close } = await rolePage(browser, 'admin');
  const project = scannedProjects()[0]!;
  const lead = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: XRW });
  await c.step('assign AppSec on one project', async () => {
    await page.goto('/settings?tab=bindings');
    await settle(page);
    const form = page.getByRole('form', { name: 'Assign role' });
    await form.getByRole('combobox', { name: 'Person' }).click();
    await page.getByRole('option', { name: new RegExp(esc(shared.leadEmail!)) }).click();
    await form.getByRole('combobox', { name: 'Role' }).click();
    await page.getByRole('option', { name: 'AppSec', exact: true }).click();
    await form.getByRole('combobox', { name: 'Scope' }).click();
    await page.getByRole('option', { name: new RegExp(esc(project.name)) }).click();
    await c.snap(page, 'form');
    await form.getByRole('button', { name: 'Assign role' }).click();
    await expect(page.getByText(/^Assigned AppSec to /)).toBeVisible();
    const table = page.getByRole('table', { name: 'Role bindings' });
    await page.getByRole('searchbox').first().fill(shared.leadEmail!);
    await expect(table.locator('tbody tr').filter({ hasText: 'AppSec' })).toContainText(`Project · ${project.name}`);
    await c.snap(page, 'assigned');
  });
  await c.step('the binding takes effect', async () => {
    const login = await lead.post('/api/auth/login', { data: { email: shared.leadEmail, password: shared.leadPassword } });
    if (!login.ok()) throw new Error(`lead sign-in: HTTP ${login.status()}`);
    const me = await getJson<{ projectPermissions: Record<string, string[]> }>(lead, '/api/me');
    const perms = me.projectPermissions[project.id] ?? [];
    if (!perms.includes('findings') || !perms.includes('investigate')) c.fail(`project permissions after AppSec binding: ${perms.join(',')}`);
    const r = await lead.get(`/api/findings?project=${encodeURIComponent(project.id)}&limit=1`);
    if (r.status() !== 200) c.fail(`lead GET /api/findings on the bound project: HTTP ${r.status()}`);
    const other = scannedProjects().find((p) => p.id !== project.id);
    if (other) {
      const r3 = await lead.get(`/api/projects/${encodeURIComponent(other.id)}/scans`);
      if (r3.status() !== 403) c.fail(`lead GET scans of an unbound project: HTTP ${r3.status()} (expected 403)`);
    }
  });
  await c.step('remove the binding', async () => {
    const table = page.getByRole('table', { name: 'Role bindings' });
    await table.getByRole('button', { name: new RegExp(`^Remove AppSec from`) }).first().click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove role' }).click();
    await expect(page.getByText(/^Removed AppSec from /)).toBeVisible();
    await expect(table.locator('tbody tr').filter({ hasText: 'AppSec' })).toHaveCount(0);
    const r = await lead.get(`/api/findings?project=${encodeURIComponent(project.id)}&limit=1`);
    if (r.status() !== 403) c.fail(`after removing the binding, lead GET /api/findings answers ${r.status()}`);
  });
  await lead.dispose();
  await close();
  c.done(w);
}

async function statusReview(browser: Browser): Promise<void> {
  // The smallest scanned project, so the findings-at-scale checks are not disturbed.
  const proj = [...scannedProjects()].reverse().find((p) => p.topFindingId);
  const c = new Check('finding status review', 'admin');
  if (!proj) {
    c.fail('no scanned project with findings');
    c.done();
    return;
  }
  const { page, w, close } = await rolePage(browser, 'admin');
  await page.goto(`/projects/${encodeURIComponent(proj.id)}/findings/${encodeURIComponent(proj.topFindingId!)}`);
  await settle(page);
  const form = page.getByRole('form', { name: 'Finding status' }).first();
  for (const [to, label] of [['Reviewed', 'reviewed'], ['New', 'new']] as const) {
    await c.step(`mark ${to}`, async () => {
      await form.getByRole('combobox', { name: 'Status' }).click();
      await page.getByRole('option', { name: to, exact: true }).click();
      await form.getByLabel('Note').fill(`hammer ${label}`);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText(`Marked ${label}`)).toBeVisible();
      const ctx = await api('admin');
      const f = await getJson<{ status: string }>(ctx, `/api/findings/${encodeURIComponent(proj.topFindingId!)}`);
      await ctx.dispose();
      if (f.status !== label) c.fail(`API status after saving ${to}: ${f.status}`);
    });
  }
  await c.snap(page);
  await close();
  c.done(w);
}

async function auditLog(browser: Browser): Promise<void> {
  const c = new Check('audit log', 'admin');
  const { page, w, close } = await rolePage(browser, 'admin');
  await page.goto('/settings?tab=audit');
  await settle(page);
  const table = page.getByRole('table', { name: 'Audit log' });
  for (const action of ['member.invite', 'user.create', 'role.create', 'role.update', 'binding.create', 'binding.delete', 'finding.status']) {
    await c.step(action, async () => {
      await page.getByRole('searchbox').first().fill(action);
      const n = await table.locator('tbody tr[data-row-id]').count();
      if (n === 0) c.fail(`audit log has no ${action} entry`);
    });
  }
  await page.getByRole('searchbox').first().fill(shared.roleName ?? 'Hammer Lead');
  await c.snap(page);
  // Clean up the custom role: unbind the lead, then delete the role.
  await c.step('clean up role', async () => {
    const ctx = await api('admin');
    const b = await getJson<{ items: { id: string; roleId: string }[] }>(ctx, '/api/bindings');
    for (const x of b.items.filter((x) => x.roleId === shared.roleId)) await ctx.delete(`/api/bindings/${x.id}`);
    if (shared.roleId) {
      const d = await ctx.delete(`/api/roles/${shared.roleId}`);
      if (!d.ok()) c.fail(`delete custom role: HTTP ${d.status()}`);
    }
    await ctx.dispose();
  });
  await close();
  c.done(w);
}

/**
 * Role matrix, bindings, finding review and the audit log depend on each other (the audit log
 * must show what the others did), so they run in order inside one test; each records its own
 * result and a failure in one does not hide the others.
 */
test('roles matrix, bindings, finding review, audit log', async ({ browser }) => {
  test.setTimeout(15 * 60_000);
  const errors: string[] = [];
  for (const [name, fn] of [
    ['roles matrix', rolesMatrix],
    ['bindings', bindingsTab],
    ['finding review', statusReview],
    ['audit log', auditLog],
  ] as const) {
    try {
      await fn(browser);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  expect(errors).toEqual([]);
});

test('theme toggle persists; System follows the OS', async ({ browser }) => {
  const c = new Check('theme persistence', 'admin');
  const context = await browser.newContext({ storageState: userFor('admin').storageState, viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await context.newPage();
  const w = watch(page);
  const cls = () => page.evaluate(() => document.documentElement.className);
  await c.step('pick Dark', async () => {
    await page.goto('/');
    await settle(page);
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    if (/rgb\(255, 255, 255\)/.test(bg)) c.fail(`dark theme body background is ${bg}`);
  });
  await c.step('persists across reload, routes and tabs', async () => {
    await page.reload();
    if (!/\bdark\b/.test(await cls())) c.fail('dark theme lost on reload');
    await page.goto('/reports');
    if (!/\bdark\b/.test(await cls())) c.fail('dark theme lost on navigation');
    const p2 = await context.newPage();
    await p2.goto('/');
    if (!/\bdark\b/.test(await p2.evaluate(() => document.documentElement.className))) c.fail('dark theme not applied in a new tab');
    await p2.close();
  });
  await c.snap(page, 'dark');
  await c.step('System follows prefers-color-scheme live', async () => {
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'System' }).click();
    await page.keyboard.press('Escape');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveClass(/\blight\b/);
  });
  await c.step('back to Light', async () => {
    await page.getByTestId('nav-user').click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await page.keyboard.press('Escape');
    await page.reload();
    if (!/\blight\b/.test(await cls())) c.fail('light theme lost on reload');
  });
  await context.close();
  c.done(w);
});

test('sign out ends that session only', async ({ browser }) => {
  const c = new Check('sign out', 'developer');
  const dev = userFor('developer');
  const page = await freshPage(browser);
  const w = watch(page);
  w.allow401(/^\/api\/me/);
  await c.step('sign in, sign out', async () => {
    await uiSignIn(page, dev.email, dev.password);
    await page.getByTestId('nav-user').click();
    await c.snap(page, 'menu');
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings/);
    const me = await page.request.get('/api/me');
    if (me.status() !== 401) c.fail(`after sign-out /api/me answers ${me.status()}`);
  });
  await c.step('other sessions of the same user still work', async () => {
    const other = await api('developer');
    const me = await other.get('/api/me');
    if (me.status() !== 200) c.fail(`the saved developer session answers ${me.status()} after another session signed out`);
    await other.dispose();
  });
  await page.context().close();
  c.done(w);
});
