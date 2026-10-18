/** 이 오류는 생성 POST 자체의 명확한 거절 응답에만 사용한다. 후속 GET 실패는 포함하지 않는다. */
export class IssuePostRejected extends Error {
  constructor(readonly status: number) { super(`ISSUE_POST_REJECTED_${status}`); }
}
export const isRejectedStatus = (status: unknown): status is number => typeof status === "number" && [400, 401, 403, 404, 410, 422, 429].includes(status);
