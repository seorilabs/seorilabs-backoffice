-- 기존 ENUM 값과 순서를 보존하고 발송 제외 상태만 끝에 추가한다.
ALTER TABLE `notification_delivery`
  MODIFY `status` ENUM('PENDING', 'PROCESSING', 'SENT', 'DEAD_LETTER', 'SUPPRESSED') NOT NULL DEFAULT 'PENDING',
  ADD COLUMN `suppressedAt` DATETIME(3) NULL,
  ADD COLUMN `suppressionReason` VARCHAR(240) NULL;
