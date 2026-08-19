import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/types/domain";

const DOMAIN_STATUS: Record<DomainError["code"], number> = {
  STATION_NOT_FOUND: 404,
  NO_ROUTE: 422,
  NO_CANDIDATES: 422,
  INVALID_INPUT: 400,
};

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

/**
 * Single translation point from thrown errors to HTTP. Unrecognized errors log
 * their detail server-side and return a generic message, so internals never
 * leak through a response body.
 */
export function toErrorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Request parameters were invalid.",
          details: error.flatten(),
        },
      },
      { status: 400 },
    );
  }

  if (error instanceof DomainError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: DOMAIN_STATUS[error.code] },
    );
  }

  console.error("[api] unhandled error", error);
  return NextResponse.json(
    { error: { code: "INTERNAL_ERROR", message: "Something went wrong." } },
    { status: 500 },
  );
}
