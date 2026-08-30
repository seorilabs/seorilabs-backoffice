# Fleet 표준 라벨 trusted transport

Backoffice는 표준 라벨 목록을 보관하지 않는다. `seorilabs/.github`의
`@seorilabs/repo-contract/standard-labels`가 가리키는
`contracts/fleet-standard-labels.json`을 고정 commit, blob SHA, canonical digest로 읽고,
그 snapshot에 결합된 작업만 실행한다.

## 실행 경계

- 대상은 `RepositoryRegistration.archived=false`이며 상태가 `MANAGED` 또는
  `NEEDS_INPUT`인 public/private 저장소다.
- automation definition의 유일한 write action capability는
  `github.standard-labels.ensure`다. PR, release, role, key, provider write는 포함하지 않는다.
- GitHub App installation token은 저장소 numeric ID 하나와 `issues:write`,
  `metadata:read`에만 제한한다. trusted adapter callback 안에서만 사용하고 즉시 폐기한다.
- 표준 라벨은 create/update만 한다. custom 라벨은 보존하며 삭제 API는 제공하지 않는다.
- 작업은 repository numeric ID, full name, registration generation, catalog digest,
  plan digest, operation idempotency key에 결합한다.
- 외부 결과가 불명확하면 같은 run을 `READBACK_FIRST`로 남긴다. 새 plan이나 write로
  추측 복구하지 않는다.

## 운영 순서

1. `POST /api/control-plane/fleet-standard-labels`에 `{"mode":"PLAN"}`을 보내 cohort와
   drift를 read-only로 고정한다. 요청에는 고유한 `Idempotency-Key`가 필요하다.
2. 응답의 `planId`, `planDigest`, cohort, catalog source identity를 확인한다.
3. Backoffice 배포 SHA와 GitHub App 설치 identity/권한을 readback한 뒤에만 같은 endpoint에
   `{"mode":"APPLY","planId":"...","planDigest":"sha256:..."}`를 보낸다.
4. 응답과 `GET /api/control-plane/fleet-standard-labels`에서 verified, readback-first,
   dead-letter를 확인한다. 같은 idempotency 요청은 저장된 공개 응답만 재생한다.

`PLAN`은 GitHub 라벨을 변경하지 않는다. `APPLY`도 write 직전 registration generation과
5분 lease를 다시 확인하고, 완료 직전 Serializable CAS와 exact provider readback을 통과해야
성공으로 기록한다.
