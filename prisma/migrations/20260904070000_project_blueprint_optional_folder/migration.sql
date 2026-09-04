-- GCP 프로젝트는 folder 없이 organization을 직접 parent로 가질 수 있다.
ALTER TABLE `control_plane_project_blueprint`
  MODIFY COLUMN `folderId` VARCHAR(30) NULL;
