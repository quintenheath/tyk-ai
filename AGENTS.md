# TYK Development Workflow

## EVOLVE Requests

Treat any developer request beginning with `EVOLVE:` as an implementation command, not a request for a proposal. Continue until the requested behavior is implemented, behaviorally verified, audited, and deployed where deployment is configured.

Use this loop:

1. Understand the request and convert it into explicit acceptance criteria.
2. Inspect the owning frontend, backend, database, storage, worker, permissions, and existing tests.
3. State a falsifiable local hypothesis and the cheapest check that could disconfirm it.
4. Make the smallest root-cause implementation.
5. Run focused validation immediately, then lint, build, and relevant tests.
6. Exercise the real user workflow through the actual application and backend.
7. Audit the changed slice for regressions, error handling, permissions, isolation, race conditions, mobile behavior, performance, and dead controls.
8. Fix every related failure found during the audit and repeat validation.
9. Verify production behavior after deployment when possible.
10. Update `TYK_REQUIREMENTS_STATUS.md` with evidence-based status.

Do not stop at compilation, a rendered button, a mock, or a single happy-path test. Do not mark a requirement complete unless the behavior itself was tested. Never fake progress, findings, queue data, provider success, extraction, authentication, scheduler activity, or export output.

## Architecture Rules

Reuse existing conversations, messages, context, documents, chunks, knowledge, research, storage, authentication, permissions, Edge Functions, and audit infrastructure. Do not create duplicate systems when an existing abstraction can be extended.

Preserve these boundaries:

- Conversation and personal state are owner-scoped by verified signed identity.
- Hardware schedules remain `AUDIT_ONLY` and scoped by audit/conversation/document unless explicitly promoted.
- Company knowledge is shared only through explicit approved promotion.
- Private storage remains private and downloads use signed URLs.
- AI is a capability selected after intent and deterministic processing; use the central provider router and fallbacks.
- External integrations such as NFPA must remain honest when unavailable.
- Never expose provider errors, secrets, stack traces, database errors, or raw internal URLs to normal users.

## Verification Standard

For frontend changes test desktop and 320/375/390/430px mobile layouts. For media changes verify stream ownership and cleanup. For backend changes test authentication, authorization, RLS/ownership, failure paths, persistence, reload/reopen behavior, and relevant concurrency. For research changes verify queue claim atomicity, real progress, persisted logs, and browser-independent execution. For document/audit changes trace upload -> storage -> record -> extraction -> structured data -> findings -> conversation -> export.

When an external dependency or environment is unavailable, complete all internal work first and report the exact blocker. Separate `VERIFIED IN PRODUCTION`, `VERIFIED LOCALLY`, `NOT TESTABLE IN THIS ENVIRONMENT`, and `BLOCKED BY EXTERNAL SERVICE`.

## Completion Report

For an EVOLVE request, report briefly:

- REQUEST
- BUILT
- TESTED
- AUDITED
- FIXED DURING LOOP
- VERIFIED
- DEPLOYED
- REMAINING BLOCKERS
- COMMIT
