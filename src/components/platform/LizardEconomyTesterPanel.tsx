"use client";

import {useEffect, useState, useTransition} from "react";

import {enqueuePlatformOperationAction, getPlatformOperationStatusAction} from "@/lib/actions/platform-ops";
import {loadLizardEconomyTesterAction, lookupPlatformUserAction} from "@/lib/actions/platform-read";
import {platformOperationConfirmationText} from "@/lib/platform/confirmation";

export function LizardEconomyTesterPanel() {
  const [reference, setReference] = useState("");
  const [platformUserId, setPlatformUserId] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [confirmation, setConfirmation] = useState("");
  const [status, setStatus] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, startTransition] = useTransition();
  const expected = platformOperationConfirmationText({operation: "platform.iap.set-economy-tester", appSlug: "lizard-tycoon", platformUserId: platformUserId.trim(), enabled});

  useEffect(() => {
    const saved = window.localStorage.getItem("lizard-economy-tester-request-id");
    if (saved && /^[0-9a-f-]{36}$/i.test(saved)) setRequestId(saved);
  }, []);

  const lookup = () => startTransition(async () => {
    const result = await lookupPlatformUserAction(reference.trim());
    if (!result.ok) {
      setPlatformUserId("");
      setStatus(result.error);
      return;
    }
    if (result.data.appId !== "lizard-tycoon" || result.data.isAnonymous) {
      setPlatformUserId("");
      setStatus("이 게임의 인증된 계정인지 확인해 주세요.");
      return;
    }
    setPlatformUserId(result.data.platformUserId);
    setConfirmation("");
    setStatus(`게임 계정 확인: ${result.data.platformUserId}. 계정 연결 여부는 등록할 때 서버가 다시 검사합니다.`);
  });

  const read = () => startTransition(async () => {
    const result = await loadLizardEconomyTesterAction(platformUserId.trim());
    setStatus(result.ok ? `서버 확인: ${result.data.enabled ? "시험 사용 중" : "미등록 또는 해제"} · 마지막 변경 ${result.data.updatedAt}` : result.error);
  });

  const submit = () => startTransition(async () => {
    const id = requestId || crypto.randomUUID();
    setRequestId(id);
    window.localStorage.setItem("lizard-economy-tester-request-id", id);
    const result = await enqueuePlatformOperationAction({
      operation: "platform.iap.set-economy-tester", requestId: id,
      appSlug: "lizard-tycoon", platformUserId: platformUserId.trim(), enabled,
      reason: "internal_validation", serverConfirmation: confirmation,
    });
    if (result.ok) {
      setStatus(`요청을 등록했습니다. 처리 번호: ${id}. 처리 결과를 조회해 주세요.`);
    } else setStatus(result.error || "요청을 등록하지 못했습니다.");
  });

  const check = () => startTransition(async () => {
    if (!requestId) return;
    const result = await getPlatformOperationStatusAction("lizard-tycoon", requestId);
    setStatus(result.ok ? `처리 상태: ${result.status ?? "대기"} · ${result.result?.summary ?? result.resultError ?? ""}` : result.error || "처리 결과를 확인하지 못했습니다.");
    if (result.ok && result.status === "completed") {
      window.localStorage.removeItem("lizard-economy-tester-request-id");
      setRequestId("");
      if (result.conclusion === "success" && platformUserId) read();
    }
  });

  return <section className="space-y-3 rounded-lg border border-neutral-200 p-4">
    <h3 className="font-semibold">크리스털 시험 계정</h3>
    <p className="text-sm text-neutral-600">게임에서 계정을 연결한 뒤 설정 화면의 지원 코드를 조회하세요. 운영자 권한, 앱 소유권, 실제 계정 연결은 서버가 확인합니다.</p>
    <label className="block text-sm">게임 지원 코드 또는 계정 ID
      <input className="mt-1 w-full rounded border p-2" value={reference} onChange={event => {setReference(event.target.value); setPlatformUserId(""); setConfirmation("");}} placeholder="지원 코드 또는 pu_..." />
    </label>
    <div className="flex gap-2">
      <button type="button" className="rounded border px-3 py-2" disabled={busy || !reference.trim()} onClick={lookup}>게임 계정 찾기</button>
      <button type="button" className="rounded border px-3 py-2" disabled={busy || !platformUserId} onClick={read}>현재 상태 조회</button>
    </div>
    {platformUserId && <p className="text-sm">확인된 계정 ID: <code>{platformUserId}</code></p>}
    <label className="block text-sm">변경할 상태
      <select className="mt-1 block rounded border p-2" value={enabled ? "enable" : "disable"} onChange={event => {setEnabled(event.target.value === "enable"); setConfirmation("");}}>
        <option value="enable">시험 사용 등록</option><option value="disable">시험 사용 해제</option>
      </select>
    </label>
    <p className="text-sm">확인 문구: <code>{expected}</code></p>
    <input className="w-full rounded border p-2" value={confirmation} onChange={event => setConfirmation(event.target.value)} aria-label="확인 문구 입력" />
    <div className="flex gap-2">
      <button type="button" className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" disabled={busy || !platformUserId || confirmation !== expected || !!requestId} onClick={submit}>변경 요청</button>
      <button type="button" className="rounded border px-3 py-2" disabled={busy || !requestId} onClick={check}>처리 결과 조회</button>
    </div>
    <p role="status" className="text-sm">{status}</p>
  </section>;
}
