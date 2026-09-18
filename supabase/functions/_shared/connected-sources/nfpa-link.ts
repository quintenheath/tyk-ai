// NFPA LiNK connector. Credentials/session tokens (if ever configured) must
// only ever live as Supabase Edge Function secrets - NEVER in this file, the
// database, or sent to any AI provider.
//
// IMPORTANT: search()/read() are intentionally not wired to a live network
// call yet. Implementing them requires either (a) an official NFPA API, or
// (b) an explicitly authorized session/browser automation approach that
// respects NFPA LiNK's access controls and copy/download restrictions. That
// must be confirmed with the account owner before any request is made - this
// connector must never guess at or attempt to reverse-engineer a login flow.
import type {
  AuthCheckResult,
  SourceConnector,
  SourceDocument,
  SourceSearchResult,
} from "./types.ts";
import { SourceNotConnectedError } from "./types.ts";

export class NfpaLinkConnector implements SourceConnector {
  provider = "nfpa_link";
  capabilities = ["search", "read", "citation", "document_metadata"];

  private hasCredentials(): boolean {
    return Boolean(
      Deno.env.get("NFPA_LINK_SESSION_TOKEN") ||
        (Deno.env.get("NFPA_LINK_USERNAME") &&
          Deno.env.get("NFPA_LINK_PASSWORD")),
    );
  }

  async checkAuth(): Promise<AuthCheckResult> {
    if (!this.hasCredentials()) {
      return { status: "disconnected", authenticationStatus: "not_configured" };
    }

    // Credentials are present but the authenticated request flow itself is
    // not yet implemented (see file header) - report a clear, honest state
    // rather than pretending to be connected.
    return {
      status: "error",
      authenticationStatus: "failed",
      error:
        "NFPA LiNK credentials are configured, but the authenticated session flow has not been implemented yet.",
    };
  }

  search(_query: string): Promise<SourceSearchResult[]> {
    throw new SourceNotConnectedError(this.provider);
  }

  read(_reference: string): Promise<SourceDocument> {
    throw new SourceNotConnectedError(this.provider);
  }
}
