import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/service";

export function controlPlaneErrorResponse(error: unknown): NextResponse {
  if (error instanceof ControlPlaneError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: "INVALID_INPUT", issues: error.issues.map(({ path, message }) => ({ path, message })) },
      { status: 400 },
    );
  }
  console.error("[control-plane] request failed:", error);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

