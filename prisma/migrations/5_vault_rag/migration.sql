-- CreateTable
CREATE TABLE `vault_chunk` (
    `id` VARCHAR(191) NOT NULL,
    `path` VARCHAR(191) NOT NULL,
    `ord` INTEGER NOT NULL,
    `heading` TEXT NULL,
    `text` TEXT NOT NULL,
    `fileHash` VARCHAR(191) NOT NULL,
    `embedding` LONGBLOB NOT NULL,
    `dim` INTEGER NOT NULL,
    `chars` INTEGER NOT NULL DEFAULT 0,
    `indexedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vault_chunk_fileHash_idx`(`fileHash`),
    INDEX `vault_chunk_indexedAt_idx`(`indexedAt`),
    UNIQUE INDEX `vault_chunk_path_ord_key`(`path`, `ord`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vault_write_request` (
    `id` VARCHAR(191) NOT NULL,
    `folder` VARCHAR(191) NOT NULL DEFAULT '받은함',
    `filename` VARCHAR(191) NOT NULL,
    `content` TEXT NOT NULL,
    `source` VARCHAR(191) NOT NULL DEFAULT 'agent',
    `requestedBy` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'DONE', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `writtenPath` VARCHAR(191) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `vault_write_request_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
