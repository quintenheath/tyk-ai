// Generic Connected Source abstraction. Every external authenticated source
// (NFPA LiNK, a manufacturer portal, a distributor site, ...) implements
// this same interface - TYK's routing/knowledge system never needs to know
// provider-specific details.
export interface SourceSearchResult {
  title: string;
  snippet: string;
  reference: string; // opaque connector-specific reference, e.g. section id
  citation: string; // human-readable citation, e.g. "NFPA 80 (2025), 5.2.1"
}

export interface SourceDocument {
  title: string;
  content: string;
  citation: string;
  sourceUrl?: string;
}

export type ConnectedSourceStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type AuthenticationStatus =
  | "not_configured"
  | "pending"
  | "authenticated"
  | "expired"
  | "failed";

export interface AuthCheckResult {
  status: ConnectedSourceStatus;
  authenticationStatus: AuthenticationStatus;
  error?: string;
}

export interface SourceConnector {
  provider: string;
  capabilities: string[];
  // Verifies whether this connector currently has everything it needs
  // (secrets configured, session valid) WITHOUT performing a search.
  checkAuth(): Promise<AuthCheckResult>;
  // Only ever called after checkAuth() reports "connected". Must never
  // attempt to bypass the source's access controls or restrictions.
  search(query: string): Promise<SourceSearchResult[]>;
  read(reference: string): Promise<SourceDocument>;
}

export class SourceNotConnectedError extends Error {
  constructor(provider: string) {
    super(`Connected source "${provider}" is not connected.`);
    this.name = "SourceNotConnectedError";
  }
}
