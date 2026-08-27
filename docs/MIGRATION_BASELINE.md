# Prisma migration baseline v1

## 목적

기존 39개 migration은 숫자 prefix의 자릿수와 중복 때문에 빈 MySQL 9.2에서
사전식 순서로 재생할 수 없다. `14_release_note_i18n`이 `6_release_note`보다,
`19_split_ad_metrics`가 `8_metric_daily`보다 먼저 실행되고, 제거된 Telegram
table도 뒤에서 다시 생성된다.

`prisma/migrations`는 최종 schema에서 생성한 단일 baseline과 이후 migration만
포함한다. 기존 SQL은 `prisma/migration-archive/legacy-v1`에 원래 이름 그대로
보존하고, 운영에서 관측한 비민감 ledger는
`prisma/migration-archive/production-ledger-v1.tsv`에 고정한다.

## 불변 계약

- `00000000000000_squashed_migrations/migration.sql`은 다시 생성하거나 수정하지 않는다.
- 이후 migration은 Prisma 기본 형식인 14자리 UTC timestamp와 소문자 slug를 쓴다.
- 동일 timestamp prefix를 두 번 쓰지 않는다.
- legacy 이름, SQL bytes, 성공 checksum, 허용된 rollback attempt 세 건을 바꾸지 않는다.
- schema 변경은 baseline 수정이 아니라 새 expand-only migration으로 추가한다.
- DB history와 파일 checksum 대조는 Prisma `migrate status`에만 의존하지 않는다.

정적 계약은 다음 명령으로 검증한다.

```bash
bash scripts/check-migration-safety.sh
bash scripts/check-migration-safety.test.sh
```

빈 MySQL 9.2 계약은 재사용 CI의 `MySQL 9.2 empty` job과 같은 명령으로 검증한다.

```bash
DATABASE_URL='mysql://.../empty_database' bash scripts/test-migration-bootstrap.sh
```

민감 데이터가 없는 운영 ledger fixture의 `legacy → resolve → deploy twice → cutover`
계약은 `MySQL 9.2 cutover` job에서 검증한다. fixture는 loopback host와
`_contract_test` suffix DB에서만 생성된다.

```bash
DATABASE_URL='mysql://.../local_contract_test' bash scripts/test-migration-cutover.sh
```

## 운영 cutover

baseline이 active인 commit을 운영에 배포하기 전에 아래 순서를 모두 지킨다.

1. 최신 논리 백업을 `.partial`에 만들고 `gzip -t`와 SHA-256 검증 뒤 checksum을 먼저,
   dump를 마지막에 완성본 이름으로 이동한다.
2. 백업을 격리 MySQL 9.2에 복원한다.
3. clone에서 `verify-migration-state --history=legacy`와 Prisma schema diff를 통과한다.
4. clone에서 exact baseline bytes로 `prisma migrate resolve --applied
   00000000000000_squashed_migrations`를 실행한다.
5. clone에서 `migrate deploy` 두 번, `--history=cutover`, schema contract, application
   row-count fingerprint 불변을 확인한다.
6. 운영에 새 백업을 만들고 복원 가능성을 확인한 뒤 최종 PR HEAD의 immutable candidate
   digest로 `k8s/migration-baseline-resolve-job.yaml`을 render해 one-shot Job 한 건만
   실행한다. `_prisma_migrations`를 직접 INSERT 또는 UPDATE하지 않는다.
7. 운영 baseline checksum과 source manifest가 일치하고 pending 0임을 읽은 뒤에만
   baseline commit을 병합한다.

Resolve Job은 source SHA, image digest, baseline SHA-256, legacy ledger SHA-256을 실행
기록에 결합하고 resolve 전 `legacy`, 직후 `cutover` 계약을 모두 검증한다. 일반
`deploy-backoffice.sh`는 이 Job을 생성하지 않는다.

최종 PR HEAD의 candidate image는 Deploy workflow를 해당 branch에서 수동 실행하며
`deploy=false`를 선택해 만든다. 이 실행은 동일한 verify와 MySQL 9.2 계약을 통과해
image를 push하지만 production deploy job은 실행하지 않는다.

운영 resolve 전에 baseline commit을 병합하면 `migrate deploy`가 기존 table에
baseline DDL을 실행한다. MySQL DDL은 일부만 적용된 채 실패할 수 있으므로 이 순서를
우회하지 않는다.

## 롤백

legacy row는 운영 DB에서 삭제하지 않는다. 이전 image는 기존 39개 이름을 그대로
찾고, 새 image는 baseline row를 찾는다. application rollback은 expand-only schema
호환 범위에서 수행하고 baseline 또는 legacy row를 삭제해 되돌리지 않는다.
