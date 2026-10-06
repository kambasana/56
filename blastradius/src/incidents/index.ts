export {
  incidentSchema,
  parseIncident,
  findJudgementWord,
  isIsoDate,
  isHttpsUrl,
  JUDGEMENT_WORDS,
  INCIDENT_ID_RE,
  ENTITY_REF_RE,
  OFFICIAL_SANCTIONS_HOSTS,
  type IncidentInput,
} from './schema.js';
export {
  loadIncidents,
  validateKbDir,
  parseIncidentYaml,
  MAX_KB_FILE_BYTES,
  type KbError,
  type KbLoadResult,
  type KbValidateResult,
} from './loader.js';
export {
  incidentsFromMalwareFacts,
  incidentAffects,
  incidentsForPurl,
  malwareFactsFromIncidents,
  CODE_INCIDENT_TYPES,
  type MalwareFactsOptions,
} from './osv-import.js';

import type { IncidentStatus } from '../core/types.js';

/** Scoring weight per status (CONTRACTS §5): confirmed 1.0, alleged 0.4, disputed/retracted 0. */
export const STATUS_WEIGHTS: Readonly<Record<IncidentStatus, number>> = {
  confirmed: 1,
  alleged: 0.4,
  disputed: 0,
  retracted: 0,
};
