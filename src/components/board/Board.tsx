"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  DndContext,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import type { Lifecycle } from "@prisma/client";
import { STAGES, STAGE_KO } from "@/lib/domain/lifecycle";
import { TypeBadge, MarketDots, Pill, StatusBadge } from "@/components/badges";
import type { BoardApp } from "@/lib/queries";
import { transitionApp } from "@/lib/actions/lifecycle";

function Card({ app }: { app: BoardApp }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: app.id,
  });
  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: 50 }
    : undefined;
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      className={`cursor-grab rounded-md border border-neutral-200 bg-white p-2.5 shadow-sm ${
        isDragging ? "opacity-60" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="text-sm font-medium leading-tight">{app.displayName}</span>
        {app.stagnationDays != null && app.stagnationDays >= 14 && (
          <span className="shrink-0 text-[10px] text-amber-600">{app.stagnationDays}d</span>
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <TypeBadge type={app.type} engine={app.engine} />
        <StatusBadge status={app.status} />
        {app.blocked && <Pill tone="red">blocked</Pill>}
        {app.approvalWaiting && <Pill tone="amber">승인</Pill>}
        {app.needsConfig && <Pill tone="neutral">확정필요</Pill>}
      </div>
      <div className="mt-1.5">
        <MarketDots targets={app.marketTargets} status={app.marketStatus} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px] text-neutral-500">
        <span>
          이슈 {app.openIssues}
          {app.p1 > 0 && <span className="ml-1 text-red-600">P1 {app.p1}</span>}
        </span>
        <Link
          href={`/apps/${app.id}`}
          className="text-blue-600 hover:underline"
          onPointerDown={(e) => e.stopPropagation()}
        >
          상세
        </Link>
      </div>
    </div>
  );
}

function Column({ stage, apps }: { stage: Lifecycle; apps: BoardApp[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={`flex min-h-[60vh] flex-col gap-2 rounded-lg border p-2 ${
        isOver ? "border-blue-400 bg-blue-50" : "border-neutral-200 bg-neutral-100"
      }`}
    >
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-semibold text-neutral-600">{STAGE_KO[stage]}</span>
        <span className="text-xs text-neutral-400">{apps.length}</span>
      </div>
      {apps.map((a) => (
        <Card key={a.id} app={a} />
      ))}
    </div>
  );
}

export function Board({ apps: initial }: { apps: BoardApp[] }) {
  const [apps, setApps] = useState(initial);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function onDragEnd(e: DragEndEvent) {
    const appId = String(e.active.id);
    const overStage = e.over?.id as Lifecycle | undefined;
    if (!overStage) return;
    const app = apps.find((a) => a.id === appId);
    if (!app || app.stage === overStage) return;

    // optimistic
    setApps((prev) =>
      prev.map((a) => (a.id === appId ? { ...a, stage: overStage } : a)),
    );
    startTransition(async () => {
      try {
        await transitionApp(appId, overStage);
        router.refresh();
      } catch {
        // 실패 시 롤백
        setApps((prev) =>
          prev.map((a) => (a.id === appId ? { ...a, stage: app.stage } : a)),
        );
      }
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="grid grid-cols-6 gap-3">
        {STAGES.map((s) => (
          <Column key={s} stage={s} apps={apps.filter((a) => a.stage === s)} />
        ))}
      </div>
    </DndContext>
  );
}
