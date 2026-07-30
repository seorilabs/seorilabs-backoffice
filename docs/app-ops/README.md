# 앱별 관리 워크스페이스

## 목표

백오피스는 모든 앱에 같은 관리 정보 구조를 제공하고, 각 게임 저장소는 자기 콘텐츠와
운영 기능만 선언형 manifest로 기여한다.

- 공통 영역: 개요, 지표, 개발, 릴리스
- 앱별 영역: 오퍼레이션, 결제·IAP, 광고, 콘텐츠, Feature Flags
- 게임 저장소 기여 파일: `.seorilabs/backoffice.json`
- 백오피스는 manifest의 데이터만 렌더하며 저장소 코드를 import하거나 임의 URL을 호출하지 않는다.

```mermaid
flowchart LR
  A["게임 저장소"] --> B["관리툴 manifest"]
  B --> C["레지스트리 시드"]
  C --> D["App 미러"]
  D --> E["앱 워크스페이스"]
  E --> F["MySQL 작업 큐"]
  F --> G["Kubernetes worker"]
  G --> H["게임 운영 어댑터"]
  H --> F
```

현재 구현은 manifest 검증·미러링, 앱 워크스페이스 UI, manifest 기반 콘텐츠 지표 수집과
Kubernetes AppOps worker를 포함한다. UI에서 manifest를 선언했다고 실행 권한이 생기지는 않으며,
백오피스의 중앙 allowlist에 등록된 게임 어댑터와 worker 전용 최소권한 Secret이 모두 있어야
실행된다.

## 정보 구조

| 영역 | 공통 또는 앱별 | 책임 |
|---|---|---|
| 개요 | 공통 | 연결 상태, 앱 구성, 지속개선 루프 |
| 지표 | 공통 | GA4와 AppsInToss 콘솔 제품 지표 |
| 오퍼레이션 | 앱별 | 배치, 통계 재집계, 콘텐츠 발행 |
| 결제·IAP | 앱별 | 상품, 테스트 계정 참조, 지급, 회수, 구매 검증 |
| 광고 | 공통과 앱별 | 노출·수익 지표, placement, 빈도 제한, 테스트 모드 |
| 콘텐츠 | 공통과 앱별 | 게임 이벤트 스펙 기반 세부 지표와 콘텐츠 작업 |
| Feature Flags | 앱별 | 환경·마켓별 플래그 조회와 변경 |
| 개발 | 공통 | GitHub 이슈, PR, AI 초안, 라이프사이클 |
| 릴리스 | 공통 | 태그, 마켓 배포, 배포 이력, 출시노트 |

## 게임 저장소에서 기여하는 방법

1. `docs/app-ops/manifest.schema.json`을 기준으로 `.seorilabs/backoffice.json`을 만든다.
2. 조회 기능과 변경 기능을 분리한다.
3. 변경 기능은 `confirmation`을 `reason` 또는 `typed`로 지정한다.
4. 지급·회수·운영 데이터 삭제 같은 고위험 기능은 `risk: "high"`와
   `confirmation: "typed"`를 사용한다.
5. 게임 저장소의 품질 게이트에서 manifest JSON Schema 검증을 실행한다.
6. 기본 브랜치 병합 후 백오피스 레지스트리 재스캔을 실행한다.

예시는 `docs/app-ops/examples/game-backoffice.example.json`에 있다.

### 콘텐츠 통계

`analytics.content`는 기존 `AppContentSpec`의 선언형 표현이다. manifest에 선언된 스펙은
백오피스 중앙 레지스트리보다 우선한다. GA4 이벤트와 파라미터 이름은 실제 게임의 이벤트
카탈로그와 일치해야 한다.

```json
{
  "version": 1,
  "analytics": {
    "content": {
      "metrics": [
        {
          "key": "starts",
          "label": "게임 시작",
          "event": "game_start",
          "agg": "count"
        }
      ]
    }
  }
}
```

### 오퍼레이션 계약

manifest는 화면과 입력 계약만 선언한다. 실행기는 manifest에서 임의 이미지, 코드, workflow
경로나 외부 URL을 받지 않는다. 백오피스 코드에 등록된 게임 어댑터만 별도
`backoffice-app-ops-worker` Deployment가 실행한다.

표준 작업 큐 입력 계약은 다음처럼 제한한다.

| 입력 | 용도 |
|---|---|
| `operation` | manifest의 `<tool-id>.<operation-id>` |
| `request_id` | 멱등·감사 식별자 |
| `params` | manifest 스키마로 검증된 비밀값이 아닌 입력 JSON |
| `reason` | 변경 사유 |

모든 변경 오퍼레이션은 사유가 필요하고, `confirmation: "typed"`는 오퍼레이션 라벨을
정확히 재입력해야 한다. 비밀번호, 영수증 원문, 스토어 토큰, Firebase 키는 manifest나
작업 큐 입력으로 전달하지 않는다. 게임 런타임 어댑터 자격증명은 웹 Pod와 분리된
`backoffice-app-ops-secrets`에만 보관한다.

worker는 UUID 기준으로 요청을 원자적으로 claim하고 최대 세 번까지만 재시도한다. 결과와 입력
파라미터는 24시간만 DB에 보관한 뒤 제거하며, 감사 이력에는 operation, actor, 사유와 입력 키만
남긴다. 결과에는 원문 토큰·영수증·비밀번호·비밀키를 포함하지 않는다.

```json
{
  "version": 1,
  "requestId": "UUID",
  "operation": "tool-id.operation-id",
  "status": "success",
  "summary": "운영자용 한 줄 결과",
  "data": {},
  "completedAt": "2026-07-30T00:00:00.000Z"
}
```

## IAP 안전 기준

- 테스트 계정은 이메일과 비밀번호를 백오피스 DB에 저장하지 않는다.
- 화면에는 내부 `test_account_ref`와 환경, 마켓, 현재 entitlement만 표시한다.
- 지급·회수 요청은 동일 `request_id` 재실행 시 결과가 바뀌지 않아야 한다.
- 실제 결제와 무료 지급은 서로 다른 ledger source로 기록한다.
- 회수는 원장 삭제가 아니라 보상 전이 기록으로 처리한다.
- production 대상 지급·회수는 `typed` 확인과 별도 최소권한 worker adapter를 사용한다.

## Feature Flag 안전 기준

- `environment`, `market`, `flag_key`, `current_value`, `target_value`를 함께 기록한다.
- kill switch는 일반 실험 플래그와 별도 고위험 오퍼레이션으로 선언한다.
- percentage rollout은 값 범위를 서버 어댑터에서도 다시 검증한다.
- 변경 완료는 worker 성공뿐 아니라 실제 원격 설정 readback까지 검증한다.

## 마이그레이션

기존 `src/lib/analytics/specs/*.ts` 콘텐츠 스펙은 호환 fallback이다. 게임별로 manifest
기여가 완료되면 해당 중앙 스펙을 제거한다. 한 번에 전체 게임을 이동하지 않는다.
