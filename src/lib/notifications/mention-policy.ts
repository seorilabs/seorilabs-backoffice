/** 실제 장애 카드의 최초 신규 전송만 담당자를 호출한다. 채널 이름은 권한이 아니다. */
export function incidentShouldMention(incident: { status: string; severity: string; providerMessageId: string | null }) {
  return incident.status === "OPEN" && incident.severity === "critical" && !incident.providerMessageId;
}
