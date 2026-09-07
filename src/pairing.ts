/**
 * Pairing: turn a code or pair URL from Toolbelt into an org connection by
 * claiming it at POST /api/bridges/pairing/claim.
 */
import type { BridgeInfo } from "./protocol.ts";
import type { OrgConnectionConfig } from "./config.ts";
import { USER_AGENT } from "./version.ts";

export interface PairTarget {
  serverUrl: string;
  code: string;
}

export interface ClaimResponse {
  protocolVersion: number;
  bridgeId: string;
  bridgeName?: string;
  organizationId: string;
  organizationName?: string;
  isPersonalOrganization?: boolean;
  userId: string;
  token: string;
  wsUrl: string;
}

export function normalizeCode(input: string): string {
  return String(input || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `https://host/bridge/pair?code=ABC123` or a bare code + `--server`. */
export function parsePairInput(input: string, serverUrl?: string | null): PairTarget {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("A pairing code or pair URL is required");
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    const code = normalizeCode(url.searchParams.get("code") || "");
    if (!code) throw new Error("The pair URL has no code");
    return { serverUrl: url.origin, code };
  }
  const code = normalizeCode(trimmed);
  if (code.length < 4) throw new Error("That does not look like a pairing code");
  if (!serverUrl) {
    throw new Error(
      "A Toolbelt server URL is required with a bare code (--server https://…)",
    );
  }
  return { serverUrl: new URL(serverUrl).origin, code };
}

export async function claimPairing(
  target: PairTarget,
  installId: string,
  bridgeInfo: BridgeInfo,
  fetchImpl: typeof fetch = fetch,
): Promise<ClaimResponse> {
  const response = await fetchImpl(`${target.serverUrl}/api/bridges/pairing/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify({ code: target.code, installId, bridgeInfo }),
    signal: AbortSignal.timeout(20_000),
  });
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json();
  } catch {
    /* non-JSON */
  }
  if (!response.ok) {
    const message = typeof payload.error === "string"
      ? payload.error
      : `Pairing failed (${response.status})`;
    throw new Error(message);
  }
  const claim = payload as unknown as ClaimResponse;
  if (!claim.token || !claim.bridgeId || !claim.organizationId) {
    throw new Error("Pairing response is missing the token");
  }
  return claim;
}

export function orgConfigFromClaim(
  claim: ClaimResponse,
  serverUrl: string,
): OrgConnectionConfig {
  const wsUrl = claim.wsUrl || `${serverUrl.replace(/^http/i, "ws")}/bridge`;
  return {
    id: claim.organizationId,
    name: claim.organizationName ||
      (claim.isPersonalOrganization ? "Personal" : claim.organizationId),
    serverUrl,
    wsUrl,
    bridgeId: claim.bridgeId,
    bridgeName: claim.bridgeName || null,
    token: claim.token,
    isPersonal: claim.isPersonalOrganization === true,
    pairedAt: new Date().toISOString(),
  };
}
