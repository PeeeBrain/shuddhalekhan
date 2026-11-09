import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { AGENT_AUDIT_SCHEMA_SQL } from '../shared/audit-db';
import { openAuditDatabase } from '../shared/audit-sqlite';
import { queryAuditRuns, queryAuditRunDetail } from './audit-queries';

interface AuditQueryRequest {
  dbPath: string;
  mode: 'runs' | 'detail';
  agentRunId?: string;
}

const request = JSON.parse(process.argv[2] || '{}') as AuditQueryRequest;
if (!request.dbPath || (request.mode !== 'runs' && request.mode !== 'detail')) {
  throw new Error('Invalid audit query fallback request');
}
mkdirSync(dirname(request.dbPath), { recursive: true });
const db = openAuditDatabase(request.dbPath);
try {
  db.exec(AGENT_AUDIT_SCHEMA_SQL);
  if (request.mode === 'runs') console.log(JSON.stringify(queryAuditRuns(db)));
  else {
    if (!request.agentRunId) throw new Error('agentRunId is required for audit detail queries');
    console.log(JSON.stringify(queryAuditRunDetail(db, request.agentRunId)));
  }
} finally {
  db.close();
}
