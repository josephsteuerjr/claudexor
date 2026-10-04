import type { harnessBinaryIdentity } from "@claudexor/core";

/** A receipt of observed work, not an estimate of the vendor's request budget.
 * Native RPC/process calls may perform unobserved HTTP requests internally. */
export interface QuotaRefreshDiagnostic {
  operationId: string;
  source: string;
  profileId: string | null;
  at: string;
  foreground: boolean;
  credentialEpoch: number | null;
  current: boolean | null;
  stage: "credential_read" | "native_refresh" | "native_rpc" | "usage_http" | "poll";
  outcome: "started" | "succeeded" | "failed" | "skipped";
  reason?: string;
  httpStatus?: number;
  retryAfterMs?: number | null;
  expiresAtMs?: number | null;
  previousExpiresAtMs?: number | null;
  hasRefreshToken?: boolean;
  binary?: ReturnType<typeof harnessBinaryIdentity>;
  nativeRpcCode?: number | null;
  native?: {
    binary: ReturnType<typeof harnessBinaryIdentity>;
    expiresAtMs: number | null;
    exitCode: number | null;
    signal: string | null;
    terminationUnconfirmed: boolean;
    childFailed: boolean;
  };
}

export type QuotaDiagnosticSink = (record: QuotaRefreshDiagnostic) => void;

export function emitQuotaDiagnostic(
  sink: QuotaDiagnosticSink | undefined,
  record: QuotaRefreshDiagnostic,
): void {
  try {
    sink?.(record);
  } catch {
    // Logs never decide whether a refresh succeeded or whether it may retry.
  }
}
