import { Storage } from "@google-cloud/storage";
import { env } from "@/lib/env";
import { parseReportFile, playInstallRows } from "../report-files";
import { createHash } from "node:crypto";

/** 월별 원천의 대상과 generation을 고정하고 전체 합계와 국가별 수치를 중복 합산하지 않는다. */
export async function readPlayInstallReport(bucket: string, packageName: string, month: string) {
  if (!/^pubsite_prod_rev_\d+$/.test(bucket) || !/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+$/.test(packageName) || !/^\d{6}$/.test(month)) throw new Error("PLAY_REPORT_TARGET_INVALID");
  if (!env.googlePlayServiceAccountJson()) throw new Error("PLAY_REPORT_PERMISSION_REQUIRED");
  const credentials = JSON.parse(env.googlePlayServiceAccountJson());
  const storage = new Storage({ credentials });
  const path = `stats/installs/installs_${packageName}_${month}_country.csv`;
  const file = storage.bucket(bucket).file(path);
  const [metadata] = await file.getMetadata();
  if (!metadata.generation || !metadata.size || Number(metadata.size) > 32 * 1024 * 1024) throw new Error("PLAY_REPORT_SIZE_INVALID");
  const pinned = storage.bucket(bucket).file(path, { generation: metadata.generation });
  const [bytes] = await pinned.download({ validation: "crc32c" });
  const rows = playInstallRows(parseReportFile(bytes, ","), packageName);
  return { rows, sourceHash: createHash("sha256").update(bytes).digest("hex"), sourceVersion: String(metadata.generation), sourceUri: `gs://${bucket}/${path}`, bytes: bytes.length };
}

export async function verifyPlayReportFile(sourceUri: string, sourceVersion: string, bytes: Buffer) {
  const uri = new URL(sourceUri);
  if (uri.protocol !== "gs:" || !/^\d{1,30}$/.test(sourceVersion)) throw new Error("PLAY_REPORT_TARGET_INVALID");
  if (!env.googlePlayServiceAccountJson()) throw new Error("PLAY_REPORT_PERMISSION_REQUIRED");
  const storage = new Storage({ credentials: JSON.parse(env.googlePlayServiceAccountJson()) });
  const [metadata] = await storage.bucket(uri.hostname).file(uri.pathname.slice(1), { generation: sourceVersion }).getMetadata();
  assertPlayReportMetadata(metadata, sourceVersion, bytes, storage);
}

export function assertPlayReportMetadata(metadata: { generation?: string | number; size?: string | number; crc32c?: string }, sourceVersion: string, bytes: Buffer, storage = new Storage()) {
  const crc = storage.crc32cGenerator(); crc.update(bytes);
  if (String(metadata.generation) !== sourceVersion || Number(metadata.size) !== bytes.length || !metadata.crc32c || crc.toString() !== metadata.crc32c) throw new Error("PLAY_REPORT_OFFICIAL_PROOF_MISMATCH");
}
