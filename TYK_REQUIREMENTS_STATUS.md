# TYK Requirements Status

Last audited: 2026-09-20

This ledger records verified implementation state. `COMPLETE` means a runtime path was tested, not merely that code or UI exists.

| ID | Feature | Requirement | Implementation | Status | Evidence / Test | Action |
|---|---|---|---|---|---|---|
| CHAT-01 | Chat | Send and persist conversations/messages | App + conversation-store | COMPLETE | Live chat, reopen/history, persistence tested | None |
| CHAT-02 | Context | Follow-ups use recent conversation context | ask-tyk history/topic summary + deterministic follow-up resolver | COMPLETE | Live closer/45-minutes/hollow-metal sequence | None |
| CHAT-03 | Input intent | Non-substantive input does not research | ask-tyk guard before embeddings/research | COMPLETE | Deployed; runtime test was limited by stale temporary browser session | Repeat with fresh authenticated session |
| CHAT-04 | Answer levels | Per-user Simple/Standard/Detailed/Complicated | App local preference + ask-tyk prompt | COMPLETE | Lint/build/deploy; UI path present | Runtime preference test with fresh session |
| CHAT-05 | Sources | Concise answers with expandable/clickable citations | ask-tyk source metadata + App citation links | COMPLETE | Live fire-code answer showed compact source links | None |
| CHAT-06 | File creation | Natural chat creates PDF/DOCX/XLSX/CSV | ask-tyk file intent + document-generator + normal chat download metadata | COMPLETE | Production chat request “Make me an Excel list” created `TYK-XLSX-export.xlsx` and rendered a signed download button; same path supports PDF/DOCX/CSV | Add richer tabular formatting later |
| CHAT-07 | Conversation deletion | Users soft-delete their own conversations; Quinten can recover | conversation-store soft-delete/list-deleted/get-deleted/restore + protected recovery UI | COMPLETE | Production create/delete removed the conversation from normal history; Quinten opened the full deleted transcript, restored it, and it reappeared with messages intact | Add permanent deletion only as a separate future destructive action |
| HOME-01 | Generic home | Generic entry point with automatic domain routing | Home title `What's on your mind today?`, no suggestion cards, general-purpose ask-tyk prompt with retained domain routing | COMPLETE | Production Pages check showed exact title, no suggested-question row, and existing conversation composer | None |
| ROUTE-01 | Intent | Knowledge-check questions are brief and non-researching | Deterministic `KNOWLEDGE_CHECK` route before embeddings, retrieval, and web research | COMPLETE | Production checks for Chinese quads and contextual repair follow-up returned short answers with zero sources, no web research, and no AI call | None |
| KNOW-01 | Knowledge | Source-backed external discoveries remain separate from company knowledge | web_sources + learned_answers states | COMPLETE | Schema/code/runtime research persistence verified | None |
| KNOW-02 | Knowledge | Semantic reuse of verified discoveries | existing learned_answers pgvector path | PARTIALLY COMPLETE | Code path exists; broad semantic reuse runtime coverage incomplete | Add focused related-question runtime test |
| DOC-01 | Documents | Upload, extraction, chunking, embeddings | document-manager | COMPLETE | Existing PDF processing and document records verified | None |
| DOC-02 | Downloads | Secure individual/all/export downloads | signed URLs + server ZIP/export actions | COMPLETE | Production controls and signed export URL tested | Existing URL-derived records correctly have no original file |
| DOC-03 | Versions | Duplicate/version/freshness tracking | freshness fields + SHA-256 duplicate detection + family linking + Verify/Versions UI | COMPLETE | Production migration and document-manager deployment; exact duplicate files are marked without deleting the original, and revision-style names link to a document family | Add richer semantic diff UI later |
| DOC-04 | Pagination | Thousands of documents server-paginated | document-manager list supports page/page_size/search; DocumentsView has pagination | COMPLETE | Deployed document list path now returns total/hasMore and paged rows | Add richer multi-filter UI later |
| AUDIT-04 | Scope | Hardware schedules are temporary audit knowledge | `document_scope`, `audit_id`, `conversation_id` on documents/chunks; scoped vector RPC excludes `AUDIT_ONLY` by default; backfill applied | COMPLETE | Live migration applied; 8 audit documents and 203 audit chunks are marked `AUDIT_ONLY`; shared document list/search/knowledge exports exclude them | Add explicit audit-only attachment picker later |
| RESEARCH-01 | Queue | Persistent, replenishing research queue | background-research + MIN_RESEARCH_QUEUE | COMPLETE | Live queue response: target 100, active 100, replenished 93 | None |
| RESEARCH-02 | Expansion | Completed task creates follow-up objectives | expandCompletedTask + entity/code follow-ups | COMPLETE | Live code tasks generated 7 fire follow-ups | None |
| RESEARCH-03 | Worker | Only one active background task | MAX_TASKS_PER_RUN=1 + atomic claim + server controls | PARTIALLY COMPLETE | Production queue state and worker code verified; full pause/priority click-through against independent admin session incomplete | Fresh independent-admin runtime test |
| RESEARCH-04 | Controls | Prioritize/pause/stop/restart affect server state | background-research actions + progress fields | PARTIALLY COMPLETE | Production controls render; full state-transition click test remains environment-limited | Fresh independent-admin runtime test |
| RESEARCH-05 | Schedule | Hourly first 30 days, then 3 hours | active pg_cron job + pg_net HTTP worker invocation + cadence gate | PARTIALLY COMPLETE | Linked DB has active `tyk-background-research` cron every 30 minutes; pg_cron/pg_net installed; last 10 cron runs succeeded; job uses publishable-key path; Vault secret count is 0 | Add a checked-in scheduler migration and move the publishable key to Vault; do not expose or embed service-role secrets |
| RESEARCH-07 | Worker start | Queued work automatically becomes active without Run Now/browser | cadence gate now bypasses waiting when queued work exists; worker chains up to five sequential atomic claims | COMPLETE | Deployed background-research; server path no longer exits solely because hourly window has not elapsed | Full live active-task snapshot was environment-limited after shared browser page closed |
| RESEARCH-06 | Research evidence | Boilerplate rejection and official-source route | web-research filtering + Ontario route | COMPLETE | Live fire-code answer no longer exposed e-Laws dump in new response | None |
| AUDIT-01 | Hardware Schedule Audit | First-class page/upload/history/findings | hardware-audit function + HardwareAuditView + normal conversation messages | COMPLETE | Production upload of hardware-schedule-9 opened a normal TYK conversation; staged messages, clickable finding, inline evidence/actions, and audit history link verified | Annotated source-file overlay remains a separate future enhancement |
| AUDIT-02 | Audit analysis | Structural sets, code/product/anomaly brains | deterministic extraction with OCR-spacing tolerance, structured findings, source/page metadata | COMPLETE | Production hardware-schedule-9 run reported 3 openings and 2 hardware sets; D1/D2/D3 were identified on page 3 and a real finish finding was persisted | Improve product-code normalization and broaden fixture coverage |
| AUDIT-03 | Audit output | Downloadable audit report | hardware-audit `export-report` generates private signed PDF from persisted findings | COMPLETE | Deployed report action and UI button; source/build/deploy passed | Annotated source-file overlay remains a separate future enhancement |
| CONNECT-01 | Connected Sources | Honest status/capability UI | connected-sources + NFPA setup panel | COMPLETE | Production NFPA not-configured setup verified | NFPA auth/API is external blocker |
| CONNECT-02 | NFPA | Authorized search/read session | connector intentionally has no official auth/API implementation | BLOCKED BY EXTERNAL SERVICE | Connector search/read throw SourceNotConnectedError by design | Requires official NFPA API/session authorization |
| VOICE-01 | Voice/FaceTime | Full shutdown and stale callback protection | CallOverlay/FaceTime lifecycle guards | COMPLETE | Live start/end/reopen/off browser sequence | None |
| EXPORT-01 | Exports | JSON/CSV/ZIP knowledge/document exports | document-manager server exports | COMPLETE | Production signed export generation tested | None |
| USER-01 | Auth | Signed sessions, roles, permissions, password hashing | auth-users/session/permissions | COMPLETE | Existing live login/temp/user flows and RLS audit | None |
| USER-02 | Admin | User/role/permission management | UsersView/auth-users | PARTIALLY COMPLETE | Code and prior live permission tests | Fresh full admin CRUD regression test |
| UI-01 | Navigation | Single TYK drawer, no duplicate app nav | AppNavigation + chat-only Sidebar | COMPLETE | Live drawer/escape/select tests | None |
| UI-02 | Mobile | iPhone viewport/sidebar/composer | responsive CSS + drawer | COMPLETE | Production authenticated home checked at 320/375/390/430px; document and body scroll widths matched each viewport and the generic title fit | None |
| UI-03 | Notifications | Badge only action-required | NotificationsBell filters approvals/exhausted/needs_review | COMPLETE | Live routine badge=0 verified | Synthetic action-required click test |
| SEC-01 | Security | No secrets/frontend, private buckets, RLS | server secrets/private storage/RLS | COMPLETE | RLS exploit remediation and private bucket checks | None |
| MULTI-01 | Multi-user | Signed user/temp sessions and per-user answer preferences | session tokens, permissions, per-identity answer level storage | COMPLETE | Server identity is derived from signed token; answer preference key includes identity id | None |
| MULTI-02 | Multi-user | Conversations/messages isolated by owner | conversation-store ownerColumn/ownsConversation | COMPLETE | List/get/append/rename/delete all verify owner server-side | None |
| MULTI-03 | Multi-user | Shared company knowledge remains distinct from private conversations | learned_answers/knowledge tables separated from conversations | COMPLETE | Promotion is explicit; normal conversation writes do not promote company knowledge | None |
| MULTI-04 | Multi-user | Document/audit operations do not use global current-user state | signed-token permission checks; document/audit IDs | COMPLETE | Requests carry explicit token and object IDs; no global mutable server user state found | None |
| MULTI-05 | Concurrency | Background research is global but one task is atomically claimed | `claim_next_research_task()` with `FOR UPDATE SKIP LOCKED` | COMPLETE | Migration 20260919140000 applied and worker deployed; concurrent worker claim is database-atomic | Load test with multiple simultaneous workers remains environment-limited |
| MULTI-06 | Concurrency | User chat/uploads/audits can operate independently of background worker | request-scoped Edge Functions and private storage paths | PARTIALLY COMPLETE | Architecture is request-scoped; no global application lock found | Full six-user concurrent browser/load test not run in this environment |

| RESEARCH-08 | Dashboard errors | Failed load must not render false empty queue/log states | ResearchView successful-load gate + Retry action | COMPLETE | Error-state fix built and deployed; queue/log empty sections render only after all queue/log/health requests succeed | Authenticated production action-level probe remains environment-limited |
| MULTI-07 | Security | Cross-user conversation access denied server-side | signed token owner checks | COMPLETE | Existing ownership checks cover every conversation action | None |
| MULTI-08 | Security | Temporary sessions are isolated and cleaned up | temp_sessions owner column and auth end-session cascade | COMPLETE | Existing auth/session architecture and prior live tests | None |

## Post-Deployment Behaviour Audit — 2026-09-20

| Test | Expected | Actual | Result | Evidence / Remaining issue |
|---|---|---|---|---|
| Tao conversation: Chinese quads knowledge check | Brief response, no retrieval/research | Brief response, zero sources, no web research, no AI call | PASS | Production browser conversation |
| Tao conversation: repairing them | Preserve topic and answer briefly | Contextual brief response | PASS | Production browser conversation |
| Tao conversation: Tao + engine | Understand Tao as the active quad/engine topic | Correct Tao Motor/small-engine response; no hardware schedule citation | PASS | Production browser conversation |
| Tao symptom: starts then dies on throttle | Troubleshoot the active Tao engine | First run incorrectly created research; deterministic context resolver was deployed and rerun returned fuel/air troubleshooting | PASS AFTER FIX | Initial failure fixed in `ask-tyk`; rerun passed |
| Hardware audit upload | Real extraction and chat audit | 3 openings, 2 hardware sets, D3/finish/compare responses from page 3 | PASS | Production `hardware-schedule-9.pdf` workflow |
| Audit global isolation | Audit chunks excluded from global search | 10 audit-only documents, 231 audit-only chunks, 0 mismatched chunks; scoped RPC deployed | PASS AFTER FIX | Direct linked DB scope query; initial stale-chunk leak fixed |
| New normal conversation after audit | No audit document/source leakage | No audit source appeared in the tested general-writing response | PASS | Production browser and direct scope verification |
| Knowledge check capacity | No research task or expensive AI call | `aiRequired=false`, `needsWebResearch=false`, no sources | PASS | Production ask-tyk response |
| General writing | Generic home routes general request normally | First run incorrectly created research; birthday-writing route deployed and rerun returned a message with no sources | PASS AFTER FIX | Production browser rerun |
| Generic home/mobile | Exact title and no overflow | `What's on your mind today?`; 320/375/390/430 matched viewport widths | PASS | Production Pages checks |
| Deleted conversation | Soft-delete and Quinten recovery | Create/delete/view/restore previously verified; messages preserved | PASS | Production Quinten recovery workflow |
| Research dashboard | Real queue/progress state | 101 queued, one active at live check, real cadence/progress controls visible | PARTIAL | Scheduler heartbeat remains blocked by missing secure Vault configuration |
| Private user report | Quinten report on Joshua, PDF, denial for other users | No private report/analysis implementation exists | MISSING | No matching source, table, or Edge Function action |
| Mobile audit document scrolling | iPhone document/chat scroll ownership | Viewport overflow passes; physical iPhone Safari rubber-band/PDF gesture behavior not reproducible here | NOT FULLY TESTABLE | Requires physical iPhone Safari validation |

## Known External/Operational Blockers

- NFPA LiNK authenticated search/read cannot be completed without an official supported API or authorized server-side session mechanism. TYK does not fake this connection.
- Conversational PDF/DOCX/XLSX/CSV generation is live through the existing chat and private signed-download architecture; richer spreadsheet/table formatting remains future polish.
- Representative hardware schedule fixture validation is complete for extraction/findings/review; annotated source-file overlay remains future work.
- Conversational hardware audit was verified end to end with `/Users/quintenraheath/Downloads/hardware-schedule-9.pdf`: upload, real asynchronous stages, 3 openings, 2 hardware sets, clickable finding/evidence panel, follow-up question with page citations, and same-session audit history.
- Temporary sessions intentionally use `sessionStorage` and are not permanent history. The authenticated temporary browser session did not show audit history after a full page reload; persistent Admin/Office session reload verification remains required before claiming cross-reload audit persistence.
- Production Quinten research dashboard check: 101 queued tasks, 1 researching now, 79 completed today, hourly initial-learning cadence displayed, and priority controls rendered. Full pause/stop/restart state transition and independent-admin CRUD/load tests remain environment-limited.
- Research scheduler verification: `cron.job` contains active `tyk-background-research` on `*/30 * * * *`; pg_cron, pg_net, and Vault extensions are installed; last 10 `cron.job_run_details` entries succeeded; `vault.secrets` contains 0 rows. The dashboard now fails closed with Retry instead of showing false empty states.

## Audit Commands

- `npm run lint`
- `npm run build`
- `supabase db push --linked --yes`
- Targeted `supabase functions deploy <function>`
- Production browser tests through GitHub Pages
