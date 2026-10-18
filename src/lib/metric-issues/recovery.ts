import type { IssueReadback } from "./github";
import { isRejectedStatus } from "./post-outcome";
export interface RegistrationIntent { repository: string; marker: string; title: string; body: string; labels: string[]; appId: string; attemptId?: string }
export function unresolvedRegistrationAttempts(events: Array<{ type: string; payload: unknown }>) {
  const settled = events.filter((event) => {
    const result = event.payload as { status?: string; rejectedStatus?: unknown };
    return event.type === "METRIC_ISSUE_RESULT" && (result.status === "registered" || result.status === "needs_input" && isRejectedStatus(result.rejectedStatus));
  }).map((event) => event.payload as { attemptId?: string; marker?: string });
  return events.filter((event) => event.type === "METRIC_ISSUE_ATTEMPT").map((event) => event.payload as RegistrationIntent)
    .filter((intent) => !settled.some((result) => intent.attemptId ? result.attemptId === intent.attemptId : result.marker === intent.marker));
}
export async function recoverRegistrationAttempts(events: Array<{ type: string; payload: unknown }>, port: {
  find(intent: RegistrationIntent): Promise<IssueReadback | undefined>;
  confirm(intent: RegistrationIntent, row: IssueReadback): Promise<void>;
}) {
  for (const intent of unresolvedRegistrationAttempts(events)) {
    const row = await port.find(intent);
    if (!row || row.title !== intent.title || row.body !== intent.body || !intent.labels.every((label) => row.labels.includes(label))) return false;
    await port.confirm(intent, row);
  }
  return true;
}
