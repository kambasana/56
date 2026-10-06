/**
 * Typed client for the Blastradius web API (docs/WEB-API.md).
 *
 * All request and response types come from the server contract in
 * ../../src/server/api-types.ts (imported through the @server alias), so nothing is
 * duplicated here. Every mutating request sends `X-Requested-With: blastradius` (CSRF rule)
 * and the session cookie travels with `credentials: 'same-origin'`.
 */
import type {
  ApiError,
  ApiErrorCode,
  ChangesQuery,
  ChangesResponse,
  CreateBindingRequest,
  CreateBindingResponse,
  CreateOrgRequest,
  CreateOrgResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateRoleRequest,
  CreateRoleResponse,
  CreateScanRequest,
  CreateScanResponse,
  DevSwitchUserRequest,
  DevSwitchUserResponse,
  ExposureMatrixResponse,
  ExposureQuery,
  GetFindingResponse,
  GetProjectResponse,
  GetScanResponse,
  GraphResponse,
  HealthResponse,
  Id,
  InvestigateNodeResponse,
  InvestigateSearchResponse,
  ListAuditResponse,
  ListBindingsResponse,
  ListFindingsQuery,
  ListFindingsResponse,
  ListIntegrationsResponse,
  ListMembersResponse,
  ListOrgsResponse,
  ListProjectsResponse,
  ListReportsResponse,
  ListRolesResponse,
  ListScansResponse,
  LoginRequest,
  LoginResponse,
  MeResponse,
  OkResponse,
  OrgHomeResponse,
  PageQuery,
  ReportFormat,
  ResetRoleResponse,
  UpdateFindingStatusRequest,
  UpdateFindingStatusResponse,
  UpdateProjectRequest,
  UpdateProjectResponse,
  UpdateRoleRequest,
  UpdateRoleResponse,
} from '@server/api-types';

export type * from '@server/api-types';

/** Thrown for every non-2xx response (and for network failures, as code "internal"). */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly fields: string[];
  constructor(status: number, code: ApiErrorCode, message: string, fields: string[] = []) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export function isApiError(e: unknown, code?: ApiErrorCode): e is ApiRequestError {
  return e instanceof ApiRequestError && (code === undefined || e.code === code);
}

type Query = Record<string, string | number | boolean | null | undefined>;

/** Build `path?query`, dropping undefined, null and empty-string values. */
export function withQuery(path: string, query?: object): string {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query as Query)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `${path}?${s}` : path;
}

export type Fetcher = typeof fetch;

/** Listener for 401s, so the auth context can drop the session and redirect to /login. */
let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

let fetcher: Fetcher = (...args) => fetch(...args);
/** Tests swap the transport. */
export function setFetcher(f: Fetcher): void {
  fetcher = f;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (MUTATING.has(method)) headers['X-Requested-With'] = 'blastradius';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetcher(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiRequestError(0, 'internal', 'Network error: the server could not be reached.');
  }
  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = (data as ApiError | undefined)?.error;
    const code: ApiErrorCode = err?.code ?? (res.status === 401 ? 'unauthenticated' : res.status === 404 ? 'not_found' : 'internal');
    if (code === 'unauthenticated' && onUnauthenticated) onUnauthenticated();
    throw new ApiRequestError(res.status, code, err?.message ?? `Request failed (${res.status})`, err?.fields ?? []);
  }
  return data as T;
}

const get = <T>(path: string, query?: object, signal?: AbortSignal) => request<T>('GET', withQuery(path, query), undefined, signal);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);
const enc = encodeURIComponent;

/** One function per endpoint in docs/WEB-API.md. */
export const api = {
  health: () => get<HealthResponse>('/api/health'),

  login: (body: LoginRequest) => post<LoginResponse>('/api/auth/login', body),
  logout: () => post<OkResponse>('/api/auth/logout'),
  devSwitchUser: (body: DevSwitchUserRequest) => post<DevSwitchUserResponse>('/api/dev/switch-user', body),
  me: (signal?: AbortSignal) => get<MeResponse>('/api/me', undefined, signal),

  orgs: () => get<ListOrgsResponse>('/api/orgs'),
  createOrg: (body: CreateOrgRequest) => post<CreateOrgResponse>('/api/orgs', body),
  home: (signal?: AbortSignal) => get<OrgHomeResponse>('/api/home', undefined, signal),

  projects: (q?: { org?: Id } & PageQuery, signal?: AbortSignal) => get<ListProjectsResponse>('/api/projects', q, signal),
  project: (id: Id, signal?: AbortSignal) => get<GetProjectResponse>(`/api/projects/${enc(id)}`, undefined, signal),
  createProject: (body: CreateProjectRequest) => post<CreateProjectResponse>('/api/projects', body),
  updateProject: (id: Id, body: UpdateProjectRequest) => patch<UpdateProjectResponse>(`/api/projects/${enc(id)}`, body),
  deleteProject: (id: Id) => del<OkResponse>(`/api/projects/${enc(id)}`),

  scans: (projectId: Id, q?: PageQuery, signal?: AbortSignal) => get<ListScansResponse>(`/api/projects/${enc(projectId)}/scans`, q, signal),
  runScan: (projectId: Id, body: CreateScanRequest = {}) => post<CreateScanResponse>(`/api/projects/${enc(projectId)}/scans`, body),
  scan: (id: Id, signal?: AbortSignal) => get<GetScanResponse>(`/api/scans/${enc(id)}`, undefined, signal),

  findings: (q: ListFindingsQuery, signal?: AbortSignal) => get<ListFindingsResponse>('/api/findings', q, signal),
  finding: (id: Id, signal?: AbortSignal) => get<GetFindingResponse>(`/api/findings/${enc(id)}`, undefined, signal),
  updateFindingStatus: (id: Id, body: UpdateFindingStatusRequest) => patch<UpdateFindingStatusResponse>(`/api/findings/${enc(id)}`, body),

  exposure: (q: ExposureQuery, signal?: AbortSignal) => get<ExposureMatrixResponse>('/api/exposure', q, signal),
  changes: (q: ChangesQuery, signal?: AbortSignal) => get<ChangesResponse>('/api/changes', q, signal),

  graphForFinding: (findingId: Id, signal?: AbortSignal) => get<GraphResponse>('/api/graph', { finding: findingId }, signal),
  graphForNode: (projectId: Id, node: string, signal?: AbortSignal) => get<GraphResponse>('/api/graph', { project: projectId, node }, signal),
  investigateSearch: (projectId: Id, q: string, signal?: AbortSignal) => get<InvestigateSearchResponse>('/api/investigate/search', { project: projectId, q }, signal),
  investigateNode: (projectId: Id, id: string, signal?: AbortSignal) => get<InvestigateNodeResponse>('/api/investigate/node', { project: projectId, id }, signal),

  reports: (q?: { project?: Id } & PageQuery, signal?: AbortSignal) => get<ListReportsResponse>('/api/reports', q, signal),
  /** Download URL for a report body (use as an <a href download>). */
  reportUrl: (scanId: Id, format: ReportFormat) => `/api/reports/${enc(scanId)}.${format}`,

  integrations: (signal?: AbortSignal) => get<ListIntegrationsResponse>('/api/integrations', undefined, signal),

  roles: (signal?: AbortSignal) => get<ListRolesResponse>('/api/roles', undefined, signal),
  createRole: (body: CreateRoleRequest) => post<CreateRoleResponse>('/api/roles', body),
  updateRole: (id: Id, body: UpdateRoleRequest) => patch<UpdateRoleResponse>(`/api/roles/${enc(id)}`, body),
  resetRole: (id: Id) => post<ResetRoleResponse>(`/api/roles/${enc(id)}/reset`),
  deleteRole: (id: Id) => del<OkResponse>(`/api/roles/${enc(id)}`),

  bindings: (q?: { project?: Id }, signal?: AbortSignal) => get<ListBindingsResponse>('/api/bindings', q, signal),
  createBinding: (body: CreateBindingRequest) => post<CreateBindingResponse>('/api/bindings', body),
  deleteBinding: (id: Id) => del<OkResponse>(`/api/bindings/${enc(id)}`),

  members: (signal?: AbortSignal) => get<ListMembersResponse>('/api/members', undefined, signal),
  audit: (q?: PageQuery, signal?: AbortSignal) => get<ListAuditResponse>('/api/audit', q, signal),
};

export type Api = typeof api;
