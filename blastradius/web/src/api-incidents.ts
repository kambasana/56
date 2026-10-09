/**
 * Client for incidents, package reach, "who's behind it" and alert rules (docs/WEB-API.md, types
 * in ../../src/server/api-types-incidents.ts). Same transport, CSRF header and errors as api.ts.
 */
import type {
  AlertRule,
  CreateAlertRuleRequest,
  IncidentDetail,
  ListAlertRulesResponse,
  ListIncidentsResponse,
  NotifyIncidentResponse,
  PackageBehindResponse,
  PackageReachResponse,
  PreviewAlertRuleRequest,
  PreviewAlertRuleResponse,
  UpdateAlertRuleRequest,
  UpdateIncidentRequest,
} from '@server/api-types-incidents';
import type { CheckAlertsResponse, OkResponse } from '@server/api-types';
import { request, withQuery } from './api';

export type * from '@server/api-types-incidents';

const enc = encodeURIComponent;
const get = <T>(path: string, query?: object, signal?: AbortSignal) => request<T>('GET', withQuery(path, query), undefined, signal);

export const incidentsApi = {
  incidents: (signal?: AbortSignal) => get<ListIncidentsResponse>('/api/incidents', undefined, signal),
  incident: (id: string, signal?: AbortSignal) => get<IncidentDetail>(`/api/incidents/${enc(id)}`, undefined, signal),
  setIncidentStatus: (id: string, body: UpdateIncidentRequest) => request<IncidentDetail>('PATCH', `/api/incidents/${enc(id)}`, body),
  notifyOwners: (id: string) => request<NotifyIncidentResponse>('POST', `/api/incidents/${enc(id)}/notify`, {}),
  /** Re-check every project's stored inventory against the knowledge pack. */
  recheck: () => request<CheckAlertsResponse>('POST', '/api/alerts/check', {}),

  reach: (q: { name: string; version?: string | null }, signal?: AbortSignal) => get<PackageReachResponse>('/api/packages/reach', q, signal),
  behind: (name: string, signal?: AbortSignal) => get<PackageBehindResponse>('/api/packages/behind', { name }, signal),

  alertRules: (signal?: AbortSignal) => get<ListAlertRulesResponse>('/api/alert-rules', undefined, signal),
  createAlertRule: (body: CreateAlertRuleRequest) => request<AlertRule>('POST', '/api/alert-rules', body),
  updateAlertRule: (id: string, body: UpdateAlertRuleRequest) => request<AlertRule>('PATCH', `/api/alert-rules/${enc(id)}`, body),
  deleteAlertRule: (id: string) => request<OkResponse>('DELETE', `/api/alert-rules/${enc(id)}`),
  previewAlertRule: (body: PreviewAlertRuleRequest, signal?: AbortSignal) => request<PreviewAlertRuleResponse>('POST', '/api/alert-rules/preview', body, signal),
  testAlertRule: (channel: string) => request<OkResponse>('POST', '/api/alert-rules/test', { channel }),
};
