import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/service";

export function controlPlaneErrorResponse(error: unknown): NextResponse {
  if (error instanceof ControlPlaneError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    const humanApprovalRequired = error.issues.some((issue) =>
      issue.code === "custom"
      && issue.params?.controlPlaneCode === "HUMAN_APPROVAL_REQUIRED",
    );
    return NextResponse.json(
      {
        error: humanApprovalRequired ? "HUMAN_APPROVAL_REQUIRED" : "INVALID_INPUT",
        issues: error.issues.map(({ path, message }) => ({ path, message })),
      },
      { status: humanApprovalRequired ? 403 : 400 },
    );
  }
  console.error("[control-plane] request failed:", error);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}
