"use client";
import { useCallback, useEffect, useState } from "react";
import type { ProposalInput } from "@/lib/supervisor/contracts";
type Proposal = {
  id: string;
  title: string;
  version: number;
  digest: string;
  status: string;
  payload: ProposalInput;
  target: { name: string };
  createdAt: string;
  snoozedUntil: string | null;
  deliveryState: string | null;
  decidedBy: string | null;
  run: {
    id: string;
    status: string;
    localState: string | null;
    summary: string | null;
    checkpoint: { evidence?: string[] } | null;
  } | null;
};
type Snapshot = {
  now: string;
  observations: {
    id: string;
    summary: string;
    observedAt: string;
    references: string[];
  }[];
  proposals: Proposal[];
  state: { mode: string; activeRunId: string | null };
  targets: { id: string; name: string; enabled: boolean }[];
};
const labels: Record<string, string> = {
  READY: "검토 대기",
  SNOOZED: "7일 보류",
  APPROVED: "승인됨",
  COMPLETED: "완료",
  BLOCKED: "확인 필요",
  EXCLUDED: "제외",
  SUPERSEDED: "새 버전 있음",
  CANCELLED: "취소",
  RUNNING: "실행 중",
  UNCERTAIN: "결과 확인 필요",
  PAUSED: "대기",
  QUEUED: "PC 실행 대기",
  STOP_REQUESTED: "중단 요청",
  STOPPED: "중단 확인",
};
const displayTime = (s: string) =>
  new Date(s).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
export function SupervisorInbox() {
  const [recoveryEvidence, setRecoveryEvidence] = useState("");
  const [data, setData] = useState<Snapshot | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    const r = await fetch("/api/supervisor/snapshot", { cache: "no-store" });
    if (!r.ok)
      throw new Error("상태를 읽지 못했습니다. 연결과 권한을 확인하세요.");
    const d = (await r.json()) as Snapshot;
    setData(d);
    setSelected(
      (prev) =>
        prev ||
        new URLSearchParams(window.location.search).get("id") ||
        d.proposals.find((p) => p.status === "READY")?.id ||
        d.proposals[0]?.id ||
        null,
    );
  }, []);
  useEffect(() => {
    refresh().catch((e) => setError(e.message));
    const timer = setInterval(() => refresh().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function write(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/supervisor/" + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const result = await r.json();
        throw new Error(
          result.error === "PROPOSAL_VERSION_CHANGED" ||
            result.error === "PROPOSAL_SUPERSEDED"
            ? "검토본이 바뀌었습니다. 최신 내용을 확인하세요."
            : result.error === "EVIDENCE_NOT_READY"
              ? "근거가 오래되었거나 관찰 대기 중입니다."
              : "처리하지 못했습니다. 최신 상태와 승인 권한을 확인하세요.",
        );
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청 실패");
    } finally {
      setBusy(false);
    }
  }
  const p = data?.proposals.find((x) => x.id === selected),
    body = p?.payload;
  const canDecide =
    p &&
    (p.status === "READY" ||
      (p.status === "SNOOZED" &&
        !!p.snoozedUntil &&
        Date.parse(p.snoozedUntil) <= Date.parse(data?.now || "")));
  function decide(decision: string) {
    if (p)
      void write(`proposals/${p.id}/decision`, {
        version: p.version,
        digest: p.digest,
        decision,
      });
  }
  return (
    <>
      <div className="my-5 flex flex-wrap items-center gap-3 rounded-xl border bg-white p-4">
        <label className="flex items-center gap-2 text-sm">
          운영 모드{" "}
          <select
            aria-label="운영 모드"
            disabled={busy || !data}
            value={data?.state.mode || "OBSERVE"}
            onChange={(e) => void write("mode", { mode: e.target.value })}
            className="rounded border p-2"
          >
            <option value="OBSERVE">관찰만</option>
            <option value="ACTIVE">제안 발송과 승인 실행</option>
            <option value="PAUSED">관측과 신규 실행 중지</option>
          </select>
        </label>
        <p className="text-sm text-neutral-600">
          오전 9시, 최대 3건 · 한국 시간
        </p>
        {data?.state.activeRunId && (
          <span
            role="status"
            className="rounded bg-amber-50 px-3 py-1 text-sm text-amber-900"
          >
            진행 중인 작업 1건 · 완료 확인까지 다음 작업 대기
          </span>
        )}
      </div>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-red-800"
        >
          {error}
          <button
            onClick={() =>
              refresh()
                .then(() => setError(""))
                .catch((e) => setError(e.message))
            }
            className="ml-3 underline"
          >
            다시 읽기
          </button>
        </div>
      )}
      {!data && !error && <p role="status">작업을 읽는 중입니다.</p>}
      {data && data.proposals.length === 0 && (
        <div className="rounded-xl border bg-white p-8">
          <h2 className="font-semibold">검토할 제안이 없습니다</h2>
          <p className="mt-2 text-sm text-neutral-600">
            관측 대상 {data.targets.filter((t) => t.enabled).length}개를
            확인합니다. 근거가 충분한 작업이 있을 때 제안합니다.
          </p>
        </div>
      )}
      {data && data.proposals.length > 0 && (
        <div className="grid gap-5 md:grid-cols-[280px_minmax(0,1fr)]">
          <nav aria-label="제안 목록" className="space-y-2">
            {data.proposals.map((item) => (
              <button
                key={item.id}
                aria-current={item.id === selected ? "true" : undefined}
                onClick={() => setSelected(item.id)}
                className={`w-full rounded-xl border p-4 text-left ${item.id === selected ? "border-blue-500 bg-blue-50" : "bg-white"}`}
              >
                <span className="text-xs text-neutral-600">
                  {item.target.name} · {labels[item.status] || item.status}
                </span>
                <span className="mt-1 block font-medium">{item.title}</span>
                <span className="mt-2 block text-xs text-neutral-500">
                  검토본 {item.version} · {displayTime(item.createdAt)}
                </span>
              </button>
            ))}
          </nav>
          {p && body && (
            <article className="min-w-0 rounded-xl border bg-white p-5 sm:p-6">
              <p className="text-sm text-neutral-600">
                {p.target.name} · 검토본 {p.version}
              </p>
              <h2 className="mt-1 text-xl font-semibold">{p.title}</h2>
              <ol
                aria-label="진행 단계"
                className="my-5 grid grid-cols-4 gap-1 text-center text-xs"
              >
                {["제안", "승인", "실행", "완료 확인"].map((step, i) => (
                  <li
                    key={step}
                    className={`rounded px-1 py-3 ${i === 0 || (i === 1 && !!p.decidedBy) || (i === 2 && p.run) || (i === 3 && p.status === "COMPLETED") ? "bg-blue-100 text-blue-900" : "bg-neutral-100 text-neutral-500"}`}
                  >
                    {step}
                  </li>
                ))}
              </ol>
              <p className="whitespace-pre-wrap break-words text-sm leading-6">
                {body.problem}
              </p>
              <div className="my-4 flex flex-wrap gap-2 text-xs">
                <span className="rounded bg-neutral-100 px-3 py-2">
                  예상 {body.effortMinutes}분
                </span>
                <span className="rounded bg-neutral-100 px-3 py-2">
                  실행 상한 {body.timeLimitMinutes}분
                </span>
                <span className="rounded bg-neutral-100 px-3 py-2">
                  {body.release
                    ? body.release.markets.join(", ") + " " + body.release.until
                    : "PR 병합까지"}
                </span>
              </div>
              <section className="mb-4">
                <h3 className="font-semibold">완료 조건</h3>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {body.acceptance.map((text, i) => (
                    <li key={i} className="break-words">
                      {text}
                    </li>
                  ))}
                </ul>
              </section>
              {[
                ["변경 범위", body.scope],
                ["변경 미리보기", body.preview],
                ["설계", body.design],
                ["테스트 계획", body.tests],
              ].map(([title, text]) => (
                <details
                  key={title}
                  className="mb-2 rounded border p-3"
                  open={title === "변경 미리보기"}
                >
                  <summary className="cursor-pointer font-medium">
                    {title}
                  </summary>
                  <pre className="mt-3 whitespace-pre-wrap break-words font-sans text-sm leading-6">
                    {text}
                  </pre>
                </details>
              ))}
              <details className="my-2 rounded border p-3">
                <summary className="cursor-pointer font-medium">
                  근거와 원본 고정
                </summary>
                <ul className="mt-3 space-y-2 break-all text-xs">
                  {body.observationIds.map((id) => {
                    const o = data.observations.find((o) => o.id === id);
                    return (
                      <li key={id}>
                        {o ? (
                          <>
                            <p>{o.summary}</p>
                            <p>관측 시각: {displayTime(o.observedAt)}</p>
                            {o.references.map((ref, i) => (
                              <p key={i}>
                                {ref.startsWith("https://") ? (
                                  <a
                                    href={ref}
                                    className="text-blue-700 underline"
                                    target="_blank"
                                    rel="noreferrer"
                                  >
                                    근거 {i + 1}
                                  </a>
                                ) : (
                                  ref
                                )}
                              </p>
                            ))}
                          </>
                        ) : (
                          <p>
                            관측 {id}: 현재 유효한 관측에서 찾지 못했습니다.
                          </p>
                        )}
                      </li>
                    );
                  })}
                  <li>
                    {body.binding.kind === "git"
                      ? `설계 커밋 ${body.binding.commit}`
                      : body.binding.files
                          .map((f) => `${f.path}: ${f.sha256}`)
                          .join("\n")}
                  </li>
                  <li>검토본 해시 {p.digest}</li>
                </ul>
              </details>
              {p.run && (
                <section className="my-4 rounded border bg-neutral-50 p-4">
                  <h3 className="font-semibold">
                    {labels[p.run.localState || ""] ||
                      labels[p.status] ||
                      "진행 상태"}
                  </h3>
                  <p className="mt-2 whitespace-pre-wrap break-words text-sm">
                    {p.run.summary ||
                      "승인한 범위로 실행할 준비를 하고 있습니다."}
                  </p>
                  <ul className="mt-2 space-y-2 text-sm">
                    {p.run.checkpoint?.evidence?.map((ref, i) => (
                      <li key={i}>
                        {ref.startsWith("https://") ? (
                          <a
                            className="break-all text-blue-700 underline"
                            href={ref}
                            rel="noreferrer"
                            target="_blank"
                          >
                            완료 근거 {i + 1}
                          </a>
                        ) : (
                          <span className="break-all">{ref}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="mt-5 flex flex-wrap gap-3">
                {canDecide && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() => decide("approve")}
                      className="rounded-lg bg-blue-700 px-5 py-3 font-medium text-white disabled:opacity-50"
                    >
                      진행
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decide("snooze")}
                      className="rounded-lg border px-4 py-3"
                    >
                      7일 보류
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => decide("exclude")}
                      className="rounded-lg border px-4 py-3"
                    >
                      제외
                    </button>
                  </>
                )}
                {p.status === "APPROVED" && (
                  <button
                    disabled={busy}
                    onClick={() => decide("cancel")}
                    className="rounded-lg border border-red-300 px-4 py-3 text-red-800"
                  >
                    실행 중단 요청
                  </button>
                )}
              </div>
              {p.run?.localState === "PAUSED" &&
                data.state.activeRunId === p.run.id && (
                  <section className="mt-4 rounded border border-amber-300 p-4">
                    <h3 className="font-medium">외부 적용 결과 확인</h3>
                    <p className="mt-2 text-sm">
                      기존 프로세스는 중단됐습니다. PR, 배포 또는 문서의 실제
                      상태를 확인한 근거를 남기면 다음 작업을 시작할 수
                      있습니다.
                    </p>
                    <label className="mt-3 block text-sm">
                      확인 근거 링크
                      <input
                        type="url"
                        value={recoveryEvidence}
                        onChange={(e) => setRecoveryEvidence(e.target.value)}
                        placeholder="https://github.com/..."
                        className="mt-1 w-full rounded border p-2"
                      />
                    </label>
                    <button
                      disabled={
                        busy || !recoveryEvidence.startsWith("https://")
                      }
                      onClick={() =>
                        void write(`proposals/${p.id}/decision`, {
                          version: p.version,
                          digest: p.digest,
                          decision: "reconcile",
                          evidence: [recoveryEvidence],
                        })
                      }
                      className="mt-3 rounded border px-4 py-2"
                    >
                      결과 확인 기록과 잠금 해제
                    </button>
                  </section>
                )}
              {p.decidedBy && (
                <p className="mt-3 text-xs text-neutral-500">
                  결정한 운영자: {p.decidedBy}
                </p>
              )}
            </article>
          )}
        </div>
      )}
    </>
  );
}
