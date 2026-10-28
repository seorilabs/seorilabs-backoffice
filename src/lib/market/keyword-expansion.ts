import { configRevisionPayloadSchema } from "@/lib/control-plane/contracts";
export function expandedKeywordPayload(input: {payload:unknown;activeRevision:number;latestRevision:number;publicConfirmed:boolean;terms:string[]}) {
  if (!input.publicConfirmed) return {status:"public_unconfirmed" as const};
  if (input.activeRevision !== input.latestRevision) return {status:"needs_input" as const};
  const payload=configRevisionPayloadSchema.parse(input.payload),monitoring=payload.monitoring;
  if (!monitoring?.enabled) return {status:"not_enabled" as const};
  const terms=[...monitoring.keywords];
  for (const term of input.terms) if (term.trim() && !terms.some(before=>before.toLowerCase()===term.trim().toLowerCase()) && terms.length<30) terms.push(term.trim());
  if (terms.length===monitoring.keywords.length) return {status:"unchanged" as const};
  return {status:"ready" as const,payload:configRevisionPayloadSchema.parse({...payload,monitoring:{...monitoring,keywords:terms}})};
}
