export interface DraftRegistrationRow {
  body: string | null;
  html_url: string;
  number?: number;
  pull_request?: unknown;
}
export function exactDraftRegistration(
  rows: DraftRegistrationRow[],
  input: { repoFullName: string; draftId: string; issueNumber?: number | null },
) {
  const marker = "<!-- backoffice-draft:" + input.draftId + " -->";
  const matches = rows.filter((row) => !row.pull_request && row.body?.includes(marker));
  if (matches.length > 1)
    throw new Error("동일 초안의 등록 기록이 여러 개입니다. GitHub에서 확인하세요.");
  if (!matches.length) return null;
  const row = matches[0],
    prefix = "https://github.com/" + input.repoFullName + "/issues/";
  if (!row.html_url.startsWith(prefix)) throw new Error("등록 기록의 저장소가 일치하지 않습니다.");
  const number = input.issueNumber ?? row.number;
  if (
    !number ||
    !Number.isSafeInteger(number) ||
    !new RegExp("^" + number + "(?:#issuecomment-\\d+)?$").test(row.html_url.slice(prefix.length))
  )
    throw new Error("등록 기록의 이슈가 일치하지 않습니다.");
  return { issueNumber: number, url: row.html_url };
}
