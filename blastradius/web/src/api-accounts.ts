/**
 * Client for the account index (docs/WEB-API.md "Accounts", types in
 * ../../src/server/api-types-accounts.ts). Same transport, CSRF header and errors as api.ts.
 */
import type { AccountDetail, AccountExposureResponse, ConcentrationResponse, MarkCompromisedRequest, MarkCompromisedResponse } from '@server/api-types-accounts';
import { request, withQuery } from './api';

export type * from '@server/api-types-accounts';

const enc = encodeURIComponent;
const base = (registry: string, name: string) => `/api/accounts/${enc(registry)}/${enc(name)}`;

export const accountsApi = {
  account: (registry: string, name: string, signal?: AbortSignal) => request<AccountDetail>('GET', base(registry, name), undefined, signal),
  exposure: (registry: string, name: string, q: { since?: string; asOf?: string } = {}, signal?: AbortSignal) =>
    request<AccountExposureResponse>('GET', withQuery(`${base(registry, name)}/exposure`, q), undefined, signal),
  markCompromised: (registry: string, name: string, body: MarkCompromisedRequest) => request<MarkCompromisedResponse>('POST', `${base(registry, name)}/compromise`, body),
  concentration: (q: { projects?: string; limit?: number } = {}, signal?: AbortSignal) => request<ConcentrationResponse>('GET', withQuery('/api/accounts/concentration', q), undefined, signal),
};
