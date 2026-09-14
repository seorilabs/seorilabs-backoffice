export const RELEASE_NOTE_MARKETS = ["PLAY", "APPSTORE", "AIT"] as const;
export type ReleaseNoteMarket = (typeof RELEASE_NOTE_MARKETS)[number];

export type ReleaseBaselineRecord = {
  market: ReleaseNoteMarket;
  version: string;
  status: string;
  deployedAt: Date | null;
};

/**
 * 현재 태그를 제외하고 마켓별 마지막 성공 배포 태그를 고른다.
 * 출시노트 생성 시각이나 다른 마켓의 배포 이력은 기준으로 사용하지 않는다.
 */
export function selectPreviousReleaseVersions(
  records: ReleaseBaselineRecord[],
  currentVersion: string,
): Record<ReleaseNoteMarket, string | null> {
  const selected: Record<ReleaseNoteMarket, string | null> = {
    PLAY: null,
    APPSTORE: null,
    AIT: null,
  };

  const newestFirst = records
    .filter(
      (record) =>
        record.status === "SUCCEEDED" &&
        record.deployedAt != null &&
        record.version !== currentVersion &&
        /^v\d+\.\d+\.\d+$/.test(record.version),
    )
    .sort((a, b) => b.deployedAt!.getTime() - a.deployedAt!.getTime());

  for (const record of newestFirst) {
    if (selected[record.market] == null) selected[record.market] = record.version;
  }
  return selected;
}
