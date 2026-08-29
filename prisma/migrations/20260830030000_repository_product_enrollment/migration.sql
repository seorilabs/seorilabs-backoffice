ALTER TABLE `repository_classification_decision`
    ADD COLUMN `productDisplayName` VARCHAR(191) NULL,
    ADD COLUMN `productType` ENUM('APP', 'GAME') NULL,
    ADD COLUMN `productEngine` ENUM('RN', 'GODOT') NULL;
