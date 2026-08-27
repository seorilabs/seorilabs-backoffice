-- CreateTable
CREATE TABLE `telegram_pending` (
    `chatId` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `dataJson` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`chatId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

