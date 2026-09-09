-- 승인본보다 앞선 SDK를 쓰는 소비자를 별도 계획 종류로 분리한다.
-- SDK_UPDATE_PR로 두면 "더 낮은 버전으로 갱신"을 지시하게 되고, 실제로 필요한 조치인
-- 릴리스 발행 또는 저장소 되돌리기가 드러나지 않는다.
ALTER TABLE `platform_fleet_plan`
  MODIFY `kind` ENUM(
    'SDK_UPDATE_PR',
    'CONTRACT_ISSUE',
    'CUSTOM_UNMANAGED',
    'MISSING_UNMANAGED',
    'AHEAD_UNMANAGED',
    'COMPLIANT'
  ) NOT NULL;
