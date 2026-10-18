-- 미확인 값은 NULL. 기존 숫자·행·키는 보존한다.
ALTER TABLE `app_console_metric_daily`
  MODIFY `iaaImpressions` INTEGER NULL DEFAULT NULL,
  MODIFY `iaaEarningKrw` DOUBLE NULL DEFAULT NULL,
  MODIFY `iapTrxAmountKrw` DOUBLE NULL DEFAULT NULL,
  MODIFY `iapSettlementKrw` DOUBLE NULL DEFAULT NULL,
  MODIFY `payingUsers` INTEGER NULL DEFAULT NULL;

-- 보고서 색인도 미확인 매출을 0으로 만들지 않는다.
ALTER TABLE `org_report_daily`
  MODIFY `consoleIaaKrw` DOUBLE NULL DEFAULT NULL,
  MODIFY `consoleIapKrw` DOUBLE NULL DEFAULT NULL;
