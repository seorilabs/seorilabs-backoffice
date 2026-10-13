import { Prisma, type AppStatus } from "@prisma/client";
import { HIDDEN_APP_ERROR, isDisabledAppStatus } from "@/lib/domain/app-visibility";
import { ControlPlaneError } from "./service";

/** 숨김과 작업 등록이 같은 앱 row를 잠근 뒤 현재 상태를 확인한다. */
export async function lockAppRow(tx: Prisma.TransactionClient, appId: string) {
  const rows = await tx.$queryRaw<Array<{id: string; status: AppStatus}>>(
    Prisma.sql`SELECT id, status FROM app WHERE id = ${appId} FOR UPDATE`,
  );
  if (rows.length !== 1) throw new ControlPlaneError("앱을 찾을 수 없습니다.", 404, "APP_NOT_FOUND");
  return rows[0];
}

export async function lockAppForNewWork(
  tx: Prisma.TransactionClient,
  appId: string,
  options: {activeOnly?: boolean} = {},
) {
  const app = await lockAppRow(tx, appId);
  if (isDisabledAppStatus(app.status)) {
    throw new ControlPlaneError(HIDDEN_APP_ERROR, 409, "APP_DISABLED");
  }
  if (options.activeOnly && app.status !== "ACTIVE") {
    throw new ControlPlaneError("자동 운영이 중지된 앱에는 새 작업을 등록할 수 없습니다.", 409, "APP_INACTIVE");
  }
  return app;
}
