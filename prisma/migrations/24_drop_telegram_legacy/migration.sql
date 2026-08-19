-- Discord 전환이 끝나 Telegram 잔재를 제거한다.
-- 알림 원문인 `notification_event`는 유지하고, 다시 배달될 수 없는 TELEGRAM 배달행만 제거한다.
-- 전송 이력 자체는 `audit_log`의 `notification.sent`/`notification.failed` 기록에 남는다.
DELETE FROM `notification_delivery` WHERE `provider` = 'TELEGRAM';

ALTER TABLE `notification_delivery`
    MODIFY `provider` ENUM('DISCORD') NOT NULL;

-- Telegram ChatOps 대화 컨텍스트 테이블. `discord_turn`이 대체했고 참조하는 코드가 없다.
-- 숫자 migration 디렉터리가 사전식으로 정렬되어 빈 DB bootstrap에서는 `2_telegram_turn`,
-- `3_telegram_pending`이 이 migration 뒤에 적용된다. 순서에 의존하지 않도록 IF EXISTS를 쓴다.
DROP TABLE IF EXISTS `telegram_turn`;
DROP TABLE IF EXISTS `telegram_pending`;
