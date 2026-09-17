// 릴리스 번호 원장(release-version-ledger)이 있는 저장소에서 stable 태그를 만드는 유일한
// 경로는 중앙 release-tag.yml 이다. seorilabs/.github 의
// contracts/release-version-authority.yaml 이 allocation.performedBy 를
// release-tag-workflow-only 로 고정한다.
//
// Backoffice 가 git ref 를 직접 만들면 원장 할당도 annotated tag receipt 도 없는 태그가 된다.
// 그런 태그는 배포 경로에서 resolve-release-version 이
// "legacy-derivation-not-applicable: 원장 할당이 시작된 저장소에서는 receipt 없는 태그를
// 배포할 수 없다" 로 거부하므로, 태그는 만들어지는데 어느 마켓에도 올릴 수 없는 상태가 된다.
// (lord-ledger v1.0.4 / v1.0.5, lizard-tycoon v1.4.5 가 이 상태로 남았다.)

export const RELEASE_VERSION_LEDGER_BRANCH = "release-version-ledger";
export const RELEASE_VERSION_LEDGER_FILE = "release-version-ledger.json";
export const RELEASE_TAG_WORKFLOW_FILE = "release-tag.yml";

/**
 * dispatch 직후부터 태그 ref 가 보일 때까지의 폴링 간격.
 * 중앙 release-tag.yml 실행은 보통 30초 안팎이고, 러너 대기까지 포함해 약 150초를 본다.
 * 시간이 지나도 실패로만 끝내고 상태를 바꾸지 않으므로, 재시도하면 이미 만들어진 태그를
 * 그대로 판독해 idempotent 하게 끝난다.
 */
export const TAG_POLL_DELAYS_MS = [
  3_000, 3_000, 5_000, 5_000, 5_000, 10_000, 10_000, 15_000, 15_000, 20_000, 20_000, 40_000,
] as const;

export interface LedgerTagPorts {
  /** 태그가 가리키는 commit SHA. 없으면 null. annotated tag 는 commit 까지 peel 한다. */
  readTagCommitSha(tag: string): Promise<string | null>;
  /** 원장 브랜치의 원장 파일 원문. 없으면 null. */
  readLedgerFile(): Promise<string | null>;
  readDefaultBranch(): Promise<string>;
  readDispatchContract(
    workflowFile: string,
    ref: string,
  ): Promise<{ dispatchable: boolean; inputNames: ReadonlySet<string> }>;
  dispatch(input: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
  }): Promise<void>;
  /** 원장이 없는 레거시 저장소용 직접 생성 경로. */
  createTagDirect(input: { tag: string; sha: string }): Promise<{ created: boolean }>;
  sleep?(delayMs: number): Promise<void>;
}

export type ReleaseTagPath = "existing" | "direct" | "ledger-workflow";

export interface ReleaseTagResult {
  created: boolean;
  path: ReleaseTagPath;
}

/**
 * 선언된 입력만 채운다. 선언 안 된 입력을 보내면 GitHub 이 422 로 거부해 태그 생성이 통째로
 * 막힌다. tag 와 target_ref 는 둘 다 있어야 "이 커밋에 이 이름" 이 정해지므로 필수로 본다.
 */
export function buildReleaseTagWorkflowInputs(
  declared: ReadonlySet<string>,
  input: { tag: string; targetRef: string },
): Record<string, string> {
  for (const name of ["tag", "target_ref"]) {
    if (!declared.has(name)) {
      throw new Error(
        `${RELEASE_TAG_WORKFLOW_FILE} 이 ${name} 입력을 선언하지 않았습니다. ` +
          "중앙 release-tag caller 를 최신 판본으로 맞추세요.",
      );
    }
  }
  const inputs: Record<string, string> = {
    tag: input.tag,
    target_ref: input.targetRef,
  };
  if (declared.has("dry_run")) inputs.dry_run = "false";
  return inputs;
}

/** 태그가 요청한 commit 으로 보일 때까지 기다린다. 조회만 반복하므로 중복 생성은 없다. */
export async function waitForTagCommitSha(
  readTagCommitSha: (tag: string) => Promise<string | null>,
  input: { tag: string; sha: string },
  options: {
    delaysMs?: readonly number[];
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<void> {
  const delaysMs = options.delaysMs ?? TAG_POLL_DELAYS_MS;
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (const delayMs of delaysMs) {
    await sleep(delayMs);
    const observed = await readTagCommitSha(input.tag);
    if (observed === null) continue;
    if (observed !== input.sha) {
      throw new Error(
        `${input.tag} 이 요청한 커밋(${input.sha.slice(0, 7)})이 아니라 ` +
          `${observed.slice(0, 7)} 을 가리킵니다.`,
      );
    }
    return;
  }

  const waitedMs = delaysMs.reduce((sum, delayMs) => sum + delayMs, 0);
  throw new Error(
    `${RELEASE_TAG_WORKFLOW_FILE} 실행 후 ${Math.ceil(waitedMs / 1_000)}초 동안 ` +
      `${input.tag} 태그가 만들어지지 않았습니다. Actions 의 Release Tag 실행 결과를 확인하세요. ` +
      "태그가 이미 만들어졌다면 같은 요청을 다시 실행해도 중복 생성되지 않습니다.",
  );
}

/**
 * stable 릴리스 태그를 만든다. 원장이 있으면 중앙 release-tag.yml 로만 만들고,
 * 없으면 기존 직접 생성 경로를 쓴다.
 */
export async function createStableReleaseTag(
  ports: LedgerTagPorts,
  input: { tag: string; sha: string },
): Promise<ReleaseTagResult> {
  const existing = await ports.readTagCommitSha(input.tag);
  if (existing !== null) {
    if (existing !== input.sha) {
      throw new Error(
        `태그 ${input.tag}가 다른 커밋(${existing.slice(0, 7)})에 이미 존재합니다.`,
      );
    }
    return { created: false, path: "existing" };
  }

  if ((await ports.readLedgerFile()) === null) {
    return { ...(await ports.createTagDirect(input)), path: "direct" };
  }

  const ref = await ports.readDefaultBranch();
  const contract = await ports.readDispatchContract(RELEASE_TAG_WORKFLOW_FILE, ref);
  if (!contract.dispatchable) {
    throw new Error(
      `원장(${RELEASE_VERSION_LEDGER_BRANCH})이 있는 저장소인데 ` +
        `${RELEASE_TAG_WORKFLOW_FILE} 에 workflow_dispatch 가 없습니다. ` +
        "receipt 없는 태그는 배포가 거부되므로 태그를 만들지 않았습니다.",
    );
  }

  await ports.dispatch({
    workflowFile: RELEASE_TAG_WORKFLOW_FILE,
    ref,
    inputs: buildReleaseTagWorkflowInputs(contract.inputNames, {
      tag: input.tag,
      targetRef: input.sha,
    }),
  });
  await waitForTagCommitSha(
    (tag) => ports.readTagCommitSha(tag),
    input,
    ports.sleep ? { sleep: ports.sleep } : {},
  );
  return { created: true, path: "ledger-workflow" };
}
