# Fleet cleanup exact mutation authority

P7 태그 정본 이관의 실행 authority는 Backoffice가 보유한다. `.github`의 public reconciler는
GitHub credential이나 inventory public key를 받지 않고, `https://backoffice.vzyx.xyz`의 strict
API에 GitHub Actions OIDC로 실행을 요청한 뒤 공개 receipt만 검증한다. 이 계약은 Ready PR 생성만
승인하며 merge, release, StoreAsset production activation은 승인하지 않는다.

## Capability 발급

`POST /api/internal/fleet-migration/cleanup-capabilities`의 `ISSUE`는 control-plane admin 전용이다.
서버는 authoritative BOOTSTRAP inventory, trusted issuer key, `PLAN_ONLY`, repository source/tree,
chain head, issue approval scope, file action/replacement digest를 검증하고 최대 15분 capability를 만든다.
검증된 issuance와 plan은 capability에 보존하므로 executor가 artifact를 다시 제출하거나 provenance를
선택하지 않는다. 같은 `Idempotency-Key`는 exact request만 replay하고 scope drift는 거부한다.

## OIDC 실행 요청

실행 요청은 다음 strict body와 `Idempotency-Key: fleet-cleanup-execute:{capabilityId}`를 사용한다.

```json
{
  "operation": "EXECUTE",
  "capabilityId": "capability-id",
  "approvalScopeDigest": "sha256:...",
  "runId": "12345678901",
  "runAttempt": "1"
}
```

Bearer는 audience `seorilabs-control-plane`의 GitHub Actions OIDC만 허용한다. 서버는 issuer,
organization ID `283115031`, repository ID `1241442018`, `seorilabs/.github`, public visibility,
`refs/heads/main`, `workflow_dispatch`, GitHub-hosted runner를 검증한다. caller는
`.github/workflows/fleet-cleanup-reconciler.yml`, called workflow는
`.github/workflows/fleet-cleanup-executor-v1.yml`이어야 한다. 두 workflow SHA와 event SHA는
GitHub App으로 다시 읽은 현재 `.github` main SHA와 같아야 한다. fork, 다른 ref/path/SHA/run,
self-hosted runner, private visibility는 fail-closed다.

첫 `runId`는 durable execution에 고정된다. 같은 run의 attempt 증가 재실행은 같은 capability와
idempotency key를 사용해 lease만 회전하고 commit/ref/PR provider readback부터 재개한다. 다른 run ID,
repository, workflow는 기존 execution binding과 충돌하므로 mutation을 시작하지 않는다.

## 공개 응답과 readback

성공 응답 outer contract는 다음 공개 identity만 반환한다.

```json
{
  "contract": "seorilabs-fleet-cleanup-execution-response-v1",
  "state": "READY_PR_CREATED",
  "capabilityId": "capability-id",
  "approvalScopeDigest": "sha256:...",
  "organizationId": "283115031",
  "installationId": "142120077",
  "repository": {
    "id": "repository-id",
    "fullName": "seorilabs/repository",
    "sourceSha": "40-character-sha",
    "defaultRef": "refs/heads/main",
    "treeSha": "40-character-sha"
  },
  "digests": {
    "issuanceDigest": "sha256:...",
    "inventoryDigest": "sha256:...",
    "planDigest": "sha256:...",
    "receiptDigest": "sha256:..."
  },
  "actionScope": {
    "chainHeadDigest": null,
    "fileActionSetDigest": "sha256:...",
    "replacementFilesDigest": "sha256:..."
  },
  "receipt": {}
}
```

caller는 workflow input의 approval scope와 outer scope를 exact 비교하고, inner
`seorilabs-fleet-cleanup-execution-v1` receipt의 organization, installation, repository, source,
branch commit, open non-Draft PR, ledger digest를 다시 대조해야 한다. `401`/`403`, 알 수 없는 state,
scope mismatch는 승인으로 해석하지 않는다. Backoffice provider도 각 mutation 뒤 exact commit/ref/PR
readback을 확인하며 결과가 불명이면 동일 mutation을 재전송하지 않는다.
