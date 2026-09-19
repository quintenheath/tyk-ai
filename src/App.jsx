import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
import AppNavigation from "./components/AppNavigation";
import AttachPicker from "./components/AttachPicker";
import LoginScreen from "./components/LoginScreen";
import { askTyk as askTykRequest, toHistory } from "./utils/ask";
import { loadStoredIdentity, signOut } from "./utils/auth";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  listConversations,
  loadConversationMessages,
  promoteToCompanyKnowledge,
  renameConversation,
} from "./utils/conversations";
import { supabase } from "./utils/supabase";
import { downloadDocument, generateConversationalFile } from "./utils/documents";

// Code-split the heavier standalone views/overlays - most sessions never
// visit most of these in a given run, so there's no reason to ship their
// code in the initial bundle.
const DocumentsView = lazy(() => import("./components/DocumentsView"));
const TeachTykView = lazy(() => import("./components/TeachTykView"));
const SettingsView = lazy(() => import("./components/SettingsView"));
const UsersView = lazy(() => import("./components/UsersView"));
const ResearchView = lazy(() => import("./components/ResearchView"));
const HardwareAuditView = lazy(() => import("./components/HardwareAuditView"));
const DeletedConversationsView = lazy(() => import("./components/DeletedConversationsView"));
const CallOverlay = lazy(() => import("./components/CallOverlay"));
const FaceTimeOverlay = lazy(() => import("./components/FaceTimeOverlay"));
const SearchOverlay = lazy(() => import("./components/SearchOverlay"));
import NotificationsBell from "./components/NotificationsBell";

function App() {
  const [identity, setIdentity] = useState(() => loadStoredIdentity());
  const [signingOut, setSigningOut] = useState(false);

  const [message, setMessage] = useState("");
  const [answerLevel, setAnswerLevel] = useState("standard");
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState("");

  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [messages, setMessages] = useState([]);

  const [standaloneView, setStandaloneView] = useState(null);
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [showAttachPicker, setShowAttachPicker] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [overlay, setOverlay] = useState(null); // "call" | "facetime" | null
  const [isNavigationOpen, setIsNavigationOpen] = useState(false);
  const [selectedAuditFinding, setSelectedAuditFinding] = useState(null);
  const [deletedReadOnly, setDeletedReadOnly] = useState(false);

  const messagesEndRef = useRef(null);
  const navigationButtonRef = useRef(null);
  const view = standaloneView || (activeConversationId ? "conversation" : "home");
  const auditMessage = messages.find((item) => item.metadata?.auditId);
  const auditId = auditMessage?.metadata?.auditId || null;

  useEffect(() => {
    if (view !== "conversation" || !activeConversationId || !auditId) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const nextMessages = await loadConversationMessages(activeConversationId, identity);
        if (!stopped) setMessages(nextMessages);
      } catch (err) {
        console.error("Failed to refresh audit conversation:", err);
      }
    };
    const interval = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [activeConversationId, auditId, identity, view]);

  useEffect(() => {
    if (!isNavigationOpen) return undefined;

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setIsNavigationOpen(false);
        navigationButtonRef.current?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isNavigationOpen]);

  useEffect(() => {
    // A cached identity from before signed sessions existed (or one whose
    // token has expired) has no valid token - treat it as signed out rather
    // than letting every subsequent call fail with a confusing 401/403.
    if (identity && !identity.token) {
      setIdentity(null);
      return;
    }
    if (identity) refreshConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity]);

  useEffect(() => {
    const key = identity ? `tyk-answer-level:${identity.id}` : null;
    const saved = key ? localStorage.getItem(key) : null;
    setAnswerLevel(saved || "standard");
  }, [identity]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function refreshConversations() {
    try {
      setConversations(await listConversations(identity));
    } catch (err) {
      console.error("Failed to load conversation history:", err);
      // The very first authenticated call after login/reload failing almost
      // always means the session token is invalid/expired - sign out cleanly
      // instead of leaving every view stuck erroring silently.
      setIdentity(null);
    }
  }

  async function askTyk(question, attachedDocumentIds) {
    return askTykRequest({
      question,
      attachedDocumentIds,
      history: toHistory(messages),
      conversationId: activeConversationId,
      answerLevel,
    });
  }

  async function assistantPayload(result) {
    const metadata = { sources: result.sources, conversationMeta: result.conversationMeta };
    if (!result.fileRequest) return { content: result.answer, metadata };
    try {
      const generated = await generateConversationalFile(result.fileRequest, identity);
      return {
        content: `${result.answer}\n\nI created ${generated.fileName}. Use the download button below.`,
        metadata: { ...metadata, generatedFile: generated },
      };
    } catch (err) {
      console.error("Conversational file generation failed:", err);
      return { content: "I understood the file request, but I couldn’t create the download just now. Please try again.", metadata };
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const question = message.trim();
    if (!question || loading) return;

    const isNewConversation = !activeConversationId;
    const documentIds = attachedDocs.map((d) => d.id);
    const attachmentNames = attachedDocs.map((d) => d.name);
    setMessage("");
    setAttachedDocs([]);
    setLoading(true);
    setErrorText("");

    try {
      if (isNewConversation) {
        // First message of a new conversation: create it, then get TYK's answer.
        const { conversation, message: userMessage } =
          await createConversation({
            role: "user",
            content: question,
            metadata: attachmentNames.length ? { attachments: attachmentNames } : null,
          }, identity);

        setActiveConversationId(conversation.id);
        setMessages([userMessage]);
        setConversations((prev) => [conversation, ...prev]);

        const result = await askTyk(question, documentIds);
        const assistant = await assistantPayload(result);
        const { message: assistantMessage } = await appendMessage(
          conversation.id,
          { role: "assistant", ...assistant },
          identity,
        );

        setMessages((prev) => [...prev, assistantMessage]);
        refreshConversations();
      } else {
        const { message: userMessage } = await appendMessage(
          activeConversationId,
          {
            role: "user",
            content: question,
            metadata: attachmentNames.length ? { attachments: attachmentNames } : null,
          },
          identity,
        );
        setMessages((prev) => [...prev, userMessage]);

        const result = await askTyk(question, documentIds);
        const assistant = await assistantPayload(result);
        const { message: assistantMessage } = await appendMessage(
          activeConversationId,
          { role: "assistant", ...assistant },
          identity,
        );

        setMessages((prev) => [...prev, assistantMessage]);
        refreshConversations();
      }
    } catch (err) {
      console.error("Conversation error:", err);
      if (isNewConversation) {
        setErrorText(
          "TYK couldn't start a new conversation. Please try again.",
        );
        setMessage(question);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            id: `error-${Date.now()}`,
            role: "assistant",
            content: "Something went wrong saving that message. Please try again.",
          },
        ]);
      }
    } finally {
      setLoading(false);
    }
  }

  function handleNewChat() {
    setActiveConversationId(null);
    setMessages([]);
    setMessage("");
    setAttachedDocs([]);
    setStandaloneView(null);
    setSelectedAuditFinding(null);
    setDeletedReadOnly(false);
  }

  function handleOpenDeletedConversation(conversation, deletedMessages) {
    setStandaloneView(null);
    setActiveConversationId(conversation.id);
    setMessages(deletedMessages);
    setSelectedAuditFinding(null);
    setDeletedReadOnly(true);
  }

  async function handleOpenAuditConversation(conversationId) {
    if (!conversationId) return;
    setStandaloneView(null);
    setSelectedAuditFinding(null);
    setActiveConversationId(conversationId);
    try {
      setMessages(await loadConversationMessages(conversationId, identity));
    } catch (err) {
      console.error("Failed to open audit conversation:", err);
      setMessages([]);
    }
  }

  async function reviewAuditFinding(finding, status) {
    try {
      const { error } = await supabase.functions.invoke("hardware-audit", {
        body: { action: "review", finding_id: finding.id, status, token: identity?.token },
      });
      if (error) throw error;
      setSelectedAuditFinding((current) => current ? { ...current, status } : current);
    } catch (err) {
      console.error("Failed to review audit finding:", err);
    }
  }

  async function viewAuditEvidence(finding) {
    const documentId = finding.evidence?.document_id || finding.evidence?.documentId;
    if (!documentId) return;
    try {
      const { url } = await downloadDocument(documentId, identity);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      console.error("Failed to open audit evidence:", err);
    }
  }

  async function handleSelectConversation(conversationId) {
    setStandaloneView(null);
    if (conversationId === activeConversationId) return;
    setActiveConversationId(conversationId);
    setDeletedReadOnly(false);
    setMessages([]);
    try {
      setMessages(await loadConversationMessages(conversationId, identity));
    } catch (err) {
      console.error("Failed to load conversation:", err);
    }
  }

  async function handleDeleteConversation(conversationId) {
    try {
      await deleteConversation(conversationId, identity);
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (conversationId === activeConversationId) {
        handleNewChat();
      }
    } catch (err) {
      console.error("Failed to delete conversation:", err);
    }
  }

  async function handleRenameConversation(conversationId, title) {
    try {
      const { conversation } = await renameConversation(conversationId, title, identity);
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? conversation : c)),
      );
    } catch (err) {
      console.error("Failed to rename conversation:", err);
    }
  }

  function toggleAttachedDoc(doc) {
    setAttachedDocs((prev) =>
      prev.some((d) => d.id === doc.id)
        ? prev.filter((d) => d.id !== doc.id)
        : [...prev, doc],
    );
  }

  function handleStartOverlay(kind) {
    setStandaloneView(null);
    setOverlay(kind);
  }

  function closeNavigation() {
    setIsNavigationOpen(false);
    navigationButtonRef.current?.focus();
  }

  function handleOverlayConversationCreated(conversation, firstMessage) {
    setActiveConversationId(conversation.id);
    setMessages([firstMessage]);
    setConversations((prev) => [conversation, ...prev]);
    setStandaloneView(null);
  }

  function handleOverlayMessageAppended(newMessage) {
    setMessages((prev) => [...prev, newMessage]);
    refreshConversations();
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut(identity);
    } catch (err) {
      console.error("Sign out failed:", err);
    } finally {
      setIdentity(null);
      setConversations([]);
      setActiveConversationId(null);
      setMessages([]);
      setStandaloneView(null);
      setSigningOut(false);
    }
  }

  async function handlePromoteMessage(userMessage, assistantMessage) {
    try {
      const { pendingApproval } = await promoteToCompanyKnowledge(
        userMessage.content,
        assistantMessage.content,
        identity,
      );
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMessage.id
            ? { ...m, metadata: { ...m.metadata, promoted: true, pendingApproval } }
            : m,
        ),
      );
    } catch (err) {
      console.error("Failed to save company knowledge:", err);
    }
  }

  if (!identity) {
    return <LoginScreen onLogin={setIdentity} />;
  }

  function renderChatForm(extraClassName) {
    return (
      <form className={`chat-box ${extraClassName}`} onSubmit={handleSubmit}>
        {attachedDocs.length > 0 && (
          <div className="attached-docs">
            {attachedDocs.map((doc) => (
              <span className="attached-doc-pill" key={doc.id}>
                📄 {doc.name}
                <button
                  type="button"
                  onClick={() => toggleAttachedDoc(doc)}
                  aria-label={`Remove ${doc.name}`}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask TYK anything..."
          rows={extraClassName === "conversation-input" ? "1" : "3"}
          disabled={loading}
        />

        <div className="chat-bottom">
          <div className="chat-tools">
            <button
              type="button"
              onClick={() => setShowAttachPicker((v) => !v)}
            >
              📎 Attach
            </button>
            <button type="button" onClick={() => handleStartOverlay("call")}>
              📞 Call
            </button>
            <button type="button" onClick={() => handleStartOverlay("facetime")}>
              🎥 FaceTime
            </button>
            <label className="answer-level-control">
              <span>Answer level</span>
              <select
                value={answerLevel}
                onChange={(event) => {
                  const next = event.target.value;
                  setAnswerLevel(next);
                  if (identity) localStorage.setItem(`tyk-answer-level:${identity.id}`, next);
                }}
              >
                <option value="simple">Simple</option>
                <option value="standard">Standard</option>
                <option value="detailed">Detailed</option>
                <option value="complicated">Complicated</option>
              </select>
            </label>
          </div>

          {showAttachPicker && (
            <AttachPicker
              selectedIds={attachedDocs.map((d) => d.id)}
              onToggle={toggleAttachedDoc}
              onClose={() => setShowAttachPicker(false)}
            />
          )}

          <button
            className="send-button"
            type="submit"
            disabled={loading || !message.trim()}
          >
            {loading ? "…" : "↑"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="tyk-app">
      <Sidebar
        conversations={conversations}
        activeConversationId={activeConversationId}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
      />

      <div className="tyk-content">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">T</div>

            <div>
              <button
                ref={navigationButtonRef}
                type="button"
                className="brand-nav-toggle"
                onClick={() => setIsNavigationOpen((open) => !open)}
                aria-expanded={isNavigationOpen}
                aria-controls="app-navigation"
              >
                TYK <span aria-hidden="true">⌄</span>
              </button>
              <div className="brand-subtitle">Tykel Intelligence</div>
            </div>
          </div>

          <div className="topbar-actions">
            <button className="icon-button" onClick={() => setShowSearch(true)}>⌕</button>
            <NotificationsBell
              identity={identity}
              onOpenView={(nextView) => {
                setIsNavigationOpen(false);
                setStandaloneView(nextView);
              }}
            />
            <div className="identity-badge">
              {identity.type === "user" ? identity.name : `${identity.role} (temporary)`}
            </div>
            <button className="icon-button" onClick={handleSignOut} disabled={signingOut} title="Sign out">
              {signingOut ? "…" : "⎋"}
            </button>
          </div>
        </header>

        <AppNavigation
          identity={identity}
          isOpen={isNavigationOpen}
          onSelectView={(nextView) => {
            setOverlay(null);
            if (nextView === "home") {
              handleNewChat();
            } else if (nextView === "deleted-conversations" && (identity.isQuinten || identity.name === "Quinten")) {
              setStandaloneView(nextView);
            } else {
              setStandaloneView(nextView);
            }
          }}
          onStartOverlay={handleStartOverlay}
          onClose={closeNavigation}
        />

        <Suspense fallback={<div className="documents-empty">Loading…</div>}>
          {view === "documents" && <DocumentsView identity={identity} />}
          {view === "teach" && <TeachTykView identity={identity} />}
          {view === "settings" && <SettingsView identity={identity} />}
          {view === "users" && identity.role === "admin" && <UsersView identity={identity} />}
          {view === "research" && identity.permissions?.can_view_research && <ResearchView identity={identity} />}
          {view === "audit" && identity.permissions?.can_upload_documents && <HardwareAuditView identity={identity} onOpenConversation={handleOpenAuditConversation} />}
          {view === "deleted-conversations" && (identity.isQuinten || identity.name === "Quinten") && <DeletedConversationsView identity={identity} onOpenConversation={handleOpenDeletedConversation} onRestored={refreshConversations} />}
        </Suspense>

        {view === "home" && (
          <main className="main">
            <section className="welcome">
              <div className="status">
                <span className="status-dot"></span>
                TYK is ready
              </div>

              <h1>What's on your mind today?</h1>
            </section>

            {errorText && <div className="inline-error">{errorText}</div>}

            {renderChatForm("")}

            <div className="quick-links">
              <button type="button" onClick={() => setStandaloneView("documents")}>
                📄 Documents
              </button>
              <button type="button" onClick={() => setStandaloneView("teach")}>
                🧠 Teach TYK
              </button>
              <button type="button" onClick={() => setStandaloneView("settings")}>
                ⚙ Settings
              </button>
            </div>
          </main>
        )}

        {view === "conversation" && (
          <main className="conversation-main">
            <div className="conversation-messages">
              {messages.map((m) => (
                <div key={m.id} className={`message message-${m.role}`}>
                  <div className="message-label">
                    {m.role === "assistant" ? "TYK" : "You"}
                    {m.metadata?.mode === "voice" && " · 🎙 Voice"}
                    {m.metadata?.mode === "vision" && " · 🎥 FaceTime"}
                  </div>
                  <div className="message-text">{m.content}</div>

                  {m.metadata?.attachments?.length > 0 && (
                    <div className="message-attachments">
                      {m.metadata.attachments.map((name) => (
                        <span className="attached-doc-pill" key={name}>
                          📄 {name}
                        </span>
                      ))}
                    </div>
                  )}

                  {m.metadata?.sources?.length > 0 && (
                    <div className="message-sources">
                      <div className="message-sources-label">Sources</div>
                      {m.metadata.sources.map((source, i) => (
                        <div className="message-source" key={i}>
                          {source.url ? (
                            <a href={source.url} target="_blank" rel="noreferrer">
                              {source.document || source.domain || source.url}
                            </a>
                          ) : source.document}
                          {source.page ? ` · Page ${source.page}` : ""}
                        </div>
                      ))}
                    </div>
                  )}

                  {m.metadata?.generatedFile?.url && (
                    <button
                      type="button"
                      className="teach-skip-button generated-file-download"
                      onClick={() => window.open(m.metadata.generatedFile.url, "_blank", "noopener,noreferrer")}
                    >
                      Download {m.metadata.generatedFile.fileName || "generated file"}
                    </button>
                  )}

                  {m.metadata?.auditFindings?.length > 0 && (
                    <div className="audit-chat-findings">
                      {m.metadata.auditFindings.map((finding) => (
                        <button type="button" className="audit-chat-finding" key={finding.id} onClick={() => setSelectedAuditFinding(finding)}>
                          <span className={`document-tag audit-severity-${String(finding.severity || "INFO").toLowerCase()}`}>{finding.severity}</span>
                          <strong>{finding.title}</strong>
                          <span>{finding.description}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {identity.type === "session" &&
                    identity.permissions?.can_teach_tyk &&
                    m.role === "assistant" &&
                    !m.metadata?.promoted &&
                    (() => {
                      const idx = messages.indexOf(m);
                      const prevUser = idx > 0 ? messages[idx - 1] : null;
                      if (!prevUser || prevUser.role !== "user") return null;
                      return (
                        <button
                          type="button"
                          className="teach-skip-button promote-knowledge-button"
                          onClick={() => handlePromoteMessage(prevUser, m)}
                        >
                          {identity.permissions?.can_approve_company_knowledge
                            ? "💾 Save to company knowledge"
                            : "💾 Suggest as company knowledge"}
                        </button>
                      );
                    })()}

                  {m.metadata?.promoted && (
                    <div className="document-tag">
                      {m.metadata.pendingApproval
                        ? "Suggested - awaiting approval"
                        : "Saved to company knowledge"}
                    </div>
                  )}
                </div>
              ))}

              {loading && (
                <div className="message message-assistant">
                  <div className="message-label">TYK</div>
                  <div className="message-text message-loading">Thinking…</div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>

            {!deletedReadOnly && renderChatForm("conversation-input")}
            {deletedReadOnly && <div className="deleted-read-only-notice">Deleted conversation · read-only recovery view</div>}

            {selectedAuditFinding && (
              <aside className="audit-evidence-panel" aria-label="Audit finding details">
                <div className="audit-evidence-header">
                  <strong>Audit finding</strong>
                  <button type="button" className="icon-button" onClick={() => setSelectedAuditFinding(null)} aria-label="Close finding details">✕</button>
                </div>
                <h3>{selectedAuditFinding.title}</h3>
                <p><strong>What TYK found:</strong> {selectedAuditFinding.description}</p>
                {selectedAuditFinding.recommendation && <p><strong>Next action:</strong> {selectedAuditFinding.recommendation}</p>}
                <p><strong>Status:</strong> {selectedAuditFinding.status || "NEEDS_REVIEW"}</p>
                <p><strong>Evidence:</strong> Page {selectedAuditFinding.evidence?.page || selectedAuditFinding.evidence?.page_number || "?"}</p>
                <div className="audit-evidence-actions">
                  <button type="button" onClick={() => reviewAuditFinding(selectedAuditFinding, "ACKNOWLEDGED")}>Approve</button>
                  <button type="button" onClick={() => reviewAuditFinding(selectedAuditFinding, "RESOLVED")}>Mark Correct</button>
                  <button type="button" onClick={() => reviewAuditFinding(selectedAuditFinding, "NEEDS_REVIEW")}>Needs Review</button>
                  <button type="button" onClick={() => reviewAuditFinding(selectedAuditFinding, "RESEARCH_MORE")}>Research More</button>
                  <button type="button" onClick={() => reviewAuditFinding(selectedAuditFinding, "DISMISSED")}>Dismiss</button>
                  <button type="button" onClick={() => viewAuditEvidence(selectedAuditFinding)}>View Schedule</button>
                </div>
              </aside>
            )}
          </main>
        )}

        <Suspense fallback={null}>
          {overlay === "call" && (
            <CallOverlay
              conversationId={activeConversationId}
              messages={messages}
              identity={identity}
              onConversationCreated={handleOverlayConversationCreated}
              onMessageAppended={handleOverlayMessageAppended}
              onClose={() => setOverlay(null)}
            />
          )}

          {overlay === "facetime" && (
            <FaceTimeOverlay
              conversationId={activeConversationId}
              messages={messages}
              identity={identity}
              onConversationCreated={handleOverlayConversationCreated}
              onMessageAppended={handleOverlayMessageAppended}
              onClose={() => setOverlay(null)}
            />
          )}

          {showSearch && (
            <SearchOverlay
              identity={identity}
              onSelectConversation={handleSelectConversation}
              onOpenDocuments={() => setStandaloneView("documents")}
              onClose={() => setShowSearch(false)}
            />
          )}
        </Suspense>
      </div>
    </div>
  );
}

export default App;