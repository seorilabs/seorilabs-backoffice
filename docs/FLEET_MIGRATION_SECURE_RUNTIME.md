# Fleet migration secure runtime runbook

이 문서는 P7 BOOTSTRAP shadow를 운영 DB, GitHub App private key, config HMAC 없이
실행하는 trusted-operator 절차다. 일반 Backoffice web Pod와 CI deployer는 이 권한을
갖지 않는다. 모든 Secret 값은 `~/.config/seorilabs` canonical inventory에서 broker를
통해 execution copy로 동기화하며 명령행, 로그, PR, 문서에 값을 넣지 않는다.

## 1. migration과 DB 경계

`20260830060000_fleet_migration_bootstrap_shadow` migration은 표와 FK/index만 만든다.
`CREATE USER`, `GRANT`, `CREATE TRIGGER`는 Prisma migration에 존재하지 않는다. migration
완료 후 trusted operator가 다음 고정 NetworkPolicy를 먼저 적용한다.

```bash
kubectl apply -f k8s/fleet-migration-security-provisioning-network-policy.yaml
kubectl apply -f k8s/fleet-migration-proof-writer-network-policy.yaml
kubectl apply -f k8s/fleet-migration-bootstrap-shadow-network-policy.yaml
```

canonical credential과 공개 identity를 확인한 뒤 `data` namespace에 다음 execution
copy가 이미 있어야 한다. 값을 조회하거나 새 키로 대체하지 않는다.

- `mysql-root-cred/password`
- `fleet-migration-shadow-db-credential/{username,password}`
- `fleet-migration-proof-writer-db-credential/{username,password}`
- `fleet-migration-inventory-issuer-db-credential/{username,password}`
- `platform/fleet-migration-shadow-db/DATABASE_URL`
- `platform/fleet-migration-proof-writer-db/DATABASE_URL`
- `platform/fleet-migration-inventory-issuer-db/DATABASE_URL`

세 username은 각각 `fleet_migration_shadow`, `fleet_migration_proof_writer`,
`fleet_migration_inventory_issuer`로 고정한다.
그 다음 exact source SHA를 넣어 one-shot provisioning Job 한 건을 생성한다.

```bash
scripts/render-manifest.sh \
  k8s/fleet-migration-security-provisioning-job.yaml \
  'registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:<digest>' \
  '<40자리 Backoffice source SHA>' | kubectl create -f -
```

Job은 이미 존재하는 user의 password를 덮어쓰지 않는다. 지정 Secret으로 두 principal의
로그인을 재검증하고 다음 권한 외 global, schema, role, column, 다른 schema/table 권한이
하나라도 있으면 실패한다.

root credential은 이 provisioning Job에만 mount되고 shadow/proof runtime에는 전달되지
않는다. 임시 cnf/SQL은 종료 trap에서 지우며, Job과 Pod도 terminal 뒤 10분 안에 TTL로
제거한다. 장기 감사는 비밀 없는 verifier ConfigMap의 exact count/digest readback으로 남긴다.

- shadow/proof writer 공통 SELECT: `app`, `repository_registration`,
  `repository_classification_decision`, `control_plane_discovery_observation`,
  `control_plane_config_revision`, `platform_fleet_binding`, `platform_release`,
  `control_plane_provider_observation`, `control_plane_credential_binding`,
  `control_plane_provider_execution`, 그리고 proof/claim/completion 세 표
- shadow INSERT: claim과 completion 두 표
- proof writer INSERT: proof snapshot 한 표
- inventory issuer SELECT: `webhook_delivery`, claim, completion, authoritative issuance 네 표
- inventory issuer INSERT: authoritative issuance 한 표
- UPDATE, DELETE, DDL, TRIGGER, GRANT: 없음

동시에 proof/claim/completion/authoritative issuance의 UPDATE와 DELETE를 막는 여덟
trigger를 설치한다. 기존 여섯 개가 정확히 설치된 DB에는 issuance 두 개만 추가하며,
그 외 부분 설치, 변형, 추가 trigger는 자동 복구하지 않는다. 이후 고정 verifier가
기존 네 trigger와 합친 `total=12`, `exact=12`, repo contract digest를 새 migration
완료 시각 이후에 관측해야 rollout gate가 열린다.

## 2. INSERT-only proof 생성

trusted approval service는 repository ID/full name, source/tree/blob inventory, detector SHA,
readiness evidence/cohort, stable Backoffice state, candidates, actor, idempotency key를 묶어
5분 이하 Ed25519 `PROOF_WRITE_APPROVAL`을 발급한다. request와 공개키만 ConfigMap의
`proof-write-request.json`, `approval-public.pem`에 넣는다. private signing key와 HMAC은
ConfigMap/Job에 넣지 않는다.

approval 공개키의 SPKI SHA-256 지문은 canonical credential catalog에 미리 등록하고 trusted
operator가 `__FLEET_MIGRATION_PROOF_APPROVAL_KEY_FINGERPRINT__`를 그 64자리 hex 값으로
치환한다. 이 지문을 request ConfigMap이나 attestation의 self-reported 값에서 가져오면
공개키와 승인문을 함께 바꿀 수 있으므로 허용하지 않는다.

`k8s/fleet-migration-proof-writer-job.yaml`을 immutable image로 render하고 ConfigMap
placeholder를 exact 이름으로 바꾼 뒤 suspended 상태에서 source, image, 전용 DB Secret,
resource/securityContext를 readback한다. 일치할 때만 시작한다. writer는 Serializable
transaction 안에서 현재 Backoffice stable state를 다시 읽고 승인, request hash,
idempotency를 검증한 뒤 proof row 하나만 INSERT한다. 같은 request는 `REPLAY`, 다른
request의 같은 key는 conflict다. 결과에는 proof digest만 남는다.

## 3. exact GitHub cohort capability

trusted issuer는 기존 `getFleetScopedGithubTokenIssuer`와
`issueFleetMigrationGithubCapabilityToSink` 경계에서 다음을 한 실행으로 묶는다. 이 함수는
raw token을 반환하지 않고 broker sink에만 전달하며, sink 수락 전 실패는 즉시 revoke한다.

1. readiness와 exact repository ID/full-name cohort를 확정한다.
2. 그 cohort에만 `contents:read`, `metadata:read`인 installation token을 발급한다.
3. token SHA-256, 만료, exact cohort, Backoffice/detector SHA, readiness 두 digest,
   승인 proof digest 목록, GitHub App 공개 identity, webhook acceptance, 검증된 config
   snapshot digest를 65분 이하 Ed25519 `SHADOW_RUNTIME` attestation에 서명한다.
4. attestation과 public key는 ConfigMap, token은 별도 one-run Secret에 저장한다.

runtime 공개키의 SPKI SHA-256 지문도 canonical credential catalog에 미리 등록한다. trusted
operator는 ConfigMap과 독립된 이 값을 runner 입력으로 사용하며, attestation 또는 같은
ConfigMap의 값으로 신뢰 루트를 구성하지 않는다.

shadow Job은 projected 0440 파일만 읽고 token hash, source, execution ID, permission,
cohort, TTL을 검증한다. capability는 프로세스에서 한 번만 소비할 수 있고 terminal에서
GitHub `DELETE /installation/token`으로 폐기한다. 폐기 실패도 Job 실패다. trusted
operator는 terminal 뒤 이미 폐기된 token Secret execution copy를 제거한다.

```bash
BACKOFFICE_IMAGE='registry.vzyx.xyz/seorilabs/seorilabs-backoffice@sha256:<digest>' \
BACKOFFICE_SOURCE_SHA='<40자리 Backoffice source SHA>' \
FLEET_MIGRATION_DETECTOR_SOURCE_SHA='<40자리 detector SHA>' \
FLEET_MIGRATION_EXECUTION_ID='<signed execution ID>' \
FLEET_MIGRATION_RUNTIME_KEY_FINGERPRINT='<등록된 64자리 Ed25519 SPKI SHA-256>' \
FLEET_MIGRATION_RUNTIME_CONFIG_MAP='<signed public runtime ConfigMap>' \
FLEET_MIGRATION_GITHUB_TOKEN_SECRET='<one-run token Secret>' \
  scripts/run-fleet-migration-bootstrap-shadow.sh
```

runner는 OCI revision label, canonical NetworkPolicy, projected object key, suspended Job의
image/source/execution/resources/securityContext를 읽은 다음에만 시작한다. shadow DB write는
claim INSERT와 completion INSERT 두 건뿐이다. completion 직전에 전체 GitHub cohort의
identity/HEAD/tree와 모든 Backoffice stable state를 다시 읽고 Serializable transaction에서
final vector digest를 묶는다. DB readback 직후 capability TTL도 다시 확인하며, drift나
만료가 있으면 completion을 쓰지 않는다.

## 4. authoritative inventory signer

authoritative issuer의 public catalog 파일은 고정 공개 metadata다. mTLS CA/certificate/private
key는 한 고정 root 아래 상대 경로로만 받는다. Kubernetes projected `..data` symlink는 root
안에서만 허용하고 0440까지 허용하며 world-readable 또는 root 밖 target은 거부한다. 모든
mTLS Buffer는 성공과 실패 모두 callback 종료 시 zeroize한다. issuer의 signing private key는
Backoffice/worker에 없고 mTLS signing service 밖으로 반환되지 않는다.

`fleet-migration-inventory-signer`는 standalone 승인 서비스가 아니라 key-isolation 경계다.
실제 승인 판단은 issuer가 같은 실행 안에서 수행한 live GitHub App capability, durable collection,
canonical public catalog readback이다. signer는 그 결과로 만든 canonical attestation payload의
digest, inventory identity, 고정 key ID/fingerprint/algorithm, 시간창과 exact issuer SPIFFE만
검증한다. 요청의 collection/issuance capability evidence digest 자체를 GitHub 또는 DB에서 다시
조회하지 않으므로, signer 성공만을 승인 근거로 사용할 수 없다.

signer route는 `POST /v1/fleet-migration/inventory-signatures` 하나뿐이다. TLS 1.3과
`spiffe://seorilabs.local/ns/platform/sa/fleet-migration-inventory-issuer` client identity를 exact로
요구하고, 다른 route/redirect/content type/transfer encoding/oversize body를 거부한다. raw key,
secret, public-key export endpoint는 없다. Node `KeyObject`는 명시적 zeroize API가 없으므로 Pod는
non-root/read-only/no-shell/no-egress이며 `/usr/bin/prlimit --core=0:0`과 Node inspector/report 차단
옵션으로 시작한다. raw key/TLS file Buffer는 secure context/KeyObject 생성 직후 success/failure
모두 zeroize하고, KeyObject 메모리는 프로세스 종료로 폐기한다.

두 manifest는 배포돼도 signer `replicas: 0`, issuer Job `suspend: true`다. 다음 공개 identity와
execution copy의 logical ID/fingerprint/SPIFFE 및 exact image/source를 trusted operator가 readback한
뒤 별도 activation해야 한다. 값 조회나 신규 대체 키 생성은 하지 않는다.

- signing: `shared/platform/fleet-release-approval-signing` →
  `platform/fleet-release-approval-signing/private-key.pem`
- signer server mTLS: `shared/platform/fleet-migration-inventory-signer-server-mtls` →
  `platform/fleet-migration-inventory-signer-server/{client-ca.pem,tls.crt,tls.key}`
- issuer client mTLS: `shared/platform/fleet-migration-inventory-issuer-client-mtls` →
  `platform/fleet-migration-inventory-signer-client/{ca.pem,tls.crt,tls.key}`
- issuer DB: `shared/seori-auth/fleet-migration-inventory-issuer-db` →
  `data/fleet-migration-inventory-issuer-db-credential/{username,password}`와
  `platform/fleet-migration-inventory-issuer-db/DATABASE_URL`
- issuer GitHub App: `shared/github/backoffice-app` →
  `platform/fleet-migration-inventory-issuer-github-app/private-key.pem`

issuer는 서명 직후 dedicated `fleet_migration_inventory_issuer` DB principal로 completion과
inventory digest를 대조하고 authoritative issuance 공개 JSON을 INSERT-only 원장에 한 번 보존한다.
같은 occurrence의 재실행은 원장의 동일 issuance를 검증해 `REPLAYED`로 반환하며 새 서명이나 새 row를
만들지 않는다. `fleet-p7-trusted-readback.cjs`는 occurrence/run/provider/issuance digest를 모두
고정해 이 row를 읽고, public key로 서명과 TTL을 다시 검증한 뒤에만 trusted inventory binding,
현재 중앙 SHA의 caller readback, P7 aggregate를 만든다. GitHub App 권한, custom property,
ruleset 또는 caller readback 권한이 없으면 `null`로 남아 중앙 gate가 fail-closed한다.

이 절차의 성공은 read-only shadow와 감사 원장 완료일 뿐 plan 생성, cleanup PR, provider
변경, 배포 또는 공개 상태 승인이 아니다.
