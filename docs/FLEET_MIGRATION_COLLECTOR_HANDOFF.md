# 중앙 collector interface handoff

이번 Backoffice 보안 수정은 충돌 중인 `seorilabs/.github` 파일을 변경하지 않는다. 현재
`@seorilabs/repo-contract/fleet-migration-collector`의 v1 callback을 다음 wrapper로 안전하게
유지한다.

- `completeOccurrence`는 Backoffice finalizer가 GitHub 전체 cohort와 Backoffice stable
  state를 다시 읽은 뒤 final vector digest를 추가해 INSERT-only completion을 쓴다.
- runtime capability는 exact execution/source/cohort/TTL/permission/proof를 공개 Ed25519
  attestation으로 검증한다. 공개키는 per-run ConfigMap과 독립적으로 사전 등록된 SPKI
  SHA-256 지문에 고정하고 one-shot token은 terminal에서 폐기한다.
- provider evidence는 current source/config의 newest execution per resource만 인정하며
  non-terminal, missing observation, hash/provenance drift, non-compliant readback을 실패시킨다.

중앙 `.github`의 다음 호환 릴리스에서는 아래를 새 optional callback이 아니라 명시적 v2
contract field로 승격해야 한다.

1. completion request/response에 `finalGithubDigest`, `finalBackofficeDigest`,
   `finalizationDigest`를 포함하고 occurrence identity와 함께 검증한다.
2. collection 시작과 종료의 cohort/source vector를 별도 evidence로 보존한다.
3. GitHub read capability contract에 exact repository IDs, `contents:read`, `metadata:read`,
   token expiry, public attestation digest, terminal revoke result를 포함한다.
4. provider public evidence를 observation 단독 목록이 아니라 current source/config의
   latest execution과 `lastObservationId`가 결합된 canonical resource vector로 정의한다.

v2 배포 전까지 Backoffice wrapper를 제거하거나 v1 collector 내부에서 completion을 직접
DB UPDATE하도록 바꾸면 안 된다. 중앙 변경은 RN/Godot fixture와 이 저장소의 finalizer,
occurrence, provider latest-state 테스트를 함께 통과한 뒤 별도 PR로 진행한다.
