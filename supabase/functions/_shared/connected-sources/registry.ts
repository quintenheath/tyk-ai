// Maps a provider name to its connector implementation. Adding a new
// Connected Source (a manufacturer portal, a distributor site, ...) means
// writing one connector file and registering it here - nothing else in the
// app needs to change.
import { supabaseAdmin } from "../supabase-admin.ts";
import { NfpaLinkConnector } from "./nfpa-link.ts";
import type { SourceConnector } from "./types.ts";

const connectors: Record<string, SourceConnector> = {
  nfpa_link: new NfpaLinkConnector(),
};

export function getConnector(provider: string): SourceConnector | null {
  return connectors[provider] || null;
}

export function listConnectors(): SourceConnector[] {
  return Object.values(connectors);
}

// Refreshes a connector's live auth state and persists it to the DB row so
// the rest of the app (routing, Teach TYK, Settings UI) only ever reads from
// connected_sources instead of re-checking auth on every question.
export async function refreshConnectedSourceStatus(provider: string) {
  const connector = getConnector(provider);
  if (!connector) return null;

  const result = await connector.checkAuth();

  const { data, error } = await supabaseAdmin
    .from("connected_sources")
    .update({
      status: result.status,
      authentication_status: result.authenticationStatus,
      last_error: result.error || null,
      last_checked: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("provider", provider)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Returns the connector only if the DB currently reports it connected - the
// question router should never trust a stale/self-reported state.
export async function getActiveConnector(
  provider: string,
): Promise<SourceConnector | null> {
  const { data } = await supabaseAdmin
    .from("connected_sources")
    .select("status")
    .eq("provider", provider)
    .maybeSingle();

  if (data?.status !== "connected") return null;
  return getConnector(provider);
}
