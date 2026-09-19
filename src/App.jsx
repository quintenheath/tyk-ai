import { lazy, Suspense, useEffect, useRef, useState } from "react";
import Sidebar from "./components/Sidebar";
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

// Code-split the heavier standalone views/overlays - most sessions never
// visit most of these in a given run, so there's no reason to ship their
// code in the initial bundle.
const DocumentsView = lazy(() => import("./components/DocumentsView"));
const TeachTykView = lazy(() => import("./components/TeachTykView"));
const SettingsView = lazy(() => import("./components/SettingsView"));
const UsersView = lazy(() => import("./components/UsersView"));
const ResearchView = lazy(() => import("./components/ResearchView"));
const CallOverlay = lazy(() => import("./components/CallOverlay"));
const FaceTimeOverlay = lazy(() => import("./components/FaceTimeOverlay"));
const SearchOverlay = lazy(() => import("./components/SearchOverlay"));
import NotificationsBell from "./components/NotificationsBell";

const suggestions = [
  "What hardware is required for this door?",
  "Explain this hardware schedule",
  "What does the Ontario Building Code say?",
  "Help me troubleshoot an installation",
];

function App() {
  const [identity, setIdentity] = useState(() => loadStoredIdentity());
  const [signingOut, setSigningOut] = useState(false);

  const [message, setMessage] = useState("");
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

  const messagesEndRef = useRef(null);
  const view = standaloneView || (activeConversationId ? "conversation" : "home");

  const areaOptions = [
    { id: "home", label: "Chat" },
    ...(identity?.permissions?.can_upload_documents !== false
      ? [{ id: "documents", label: "Documents" }]
      : []),
    ...(identity?.permissions?.can_teach_tyk !== false
      ? [{ id: "teach", label: "Teach TYK" }]
      : []),
    ...(identity?.permissions?.can_view_research
      ? [{ id: "research", label: "Research" }]
      : []),
    ...(identity?.permissions?.can_view_settings !== false
      ? [{ id: "settings", label: "Settings" }]
      : []),
    ...(identity?.role === "admin" ? [{ id: "users", label: "Users" }] : []),
    { id: "call", label: "Call TYK" },
    { id: "facetime", label: "FaceTime TYK" },
  ];

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
    });
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

        const { answer, sources, conversationMeta } = await askTyk(question, documentIds);
        const { message: assistantMessage } = await appendMessage(
          conversation.id,
          { role: "assistant", content: answer, metadata: { sources, conversationMeta } },
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

        const { answer, sources, conversationMeta } = await askTyk(question, documentIds);
        const { message: assistantMessage } = await appendMessage(
          activeConversationId,
          { role: "assistant", content: answer, metadata: { sources, conversationMeta } },
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
  }

  async function handleSelectConversation(conversationId) {
    setStandaloneView(null);
    if (conversationId === activeConversationId) return;
    setActiveConversationId(conversationId);
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

  function handleAreaChange(event) {
    const nextArea = event.target.value;
    if (nextArea === "call" || nextArea === "facetime") {
      handleStartOverlay(nextArea);
      return;
    }
    setOverlay(null);
    setStandaloneView(nextArea === "home" ? "home" : nextArea);
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
        activeView={standaloneView}
        identity={identity}
        onNewChat={handleNewChat}
        onSelectConversation={handleSelectConversation}
        onDeleteConversation={handleDeleteConversation}
        onRenameConversation={handleRenameConversation}
        onSelectView={(v) => setStandaloneView(v)}
        onStartOverlay={handleStartOverlay}
      />

      <div className="tyk-content">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">T</div>

            <div>
              <label className="area-switcher">
                <span className="sr-only">TYK area</span>
                <select
                  aria-label="TYK area"
                  value={areaOptions.some((area) => area.id === view) ? view : "home"}
                  onChange={handleAreaChange}
                >
                  {areaOptions.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.id === "home" ? "TYK" : `TYK · ${area.label}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="brand-subtitle">Tykel Intelligence</div>
            </div>
          </div>

          <div className="topbar-actions">
            <button className="icon-button" onClick={() => setShowSearch(true)}>⌕</button>
            <button className="icon-button">?</button>
            <NotificationsBell identity={identity} />
            <div className="identity-badge">
              {identity.type === "user" ? identity.name : `${identity.role} (temporary)`}
            </div>
            <button className="icon-button" onClick={handleSignOut} disabled={signingOut} title="Sign out">
              {signingOut ? "…" : "⎋"}
            </button>
          </div>
        </header>

        <Suspense fallback={<div className="documents-empty">Loading…</div>}>
          {view === "documents" && <DocumentsView identity={identity} />}
          {view === "teach" && <TeachTykView identity={identity} />}
          {view === "settings" && <SettingsView identity={identity} />}
          {view === "users" && identity.role === "admin" && <UsersView identity={identity} />}
          {view === "research" && identity.permissions?.can_view_research && <ResearchView identity={identity} />}
        </Suspense>

        {view === "home" && (
          <main className="main">
            <section className="welcome">
              <div className="status">
                <span className="status-dot"></span>
                TYK is ready
              </div>

              <h1>How can I help?</h1>

              <p>
                Ask TYK about commercial doors, hardware, drawings,
                installations, specifications, or your Tykel knowledge.
              </p>
            </section>

            {errorText && <div className="inline-error">{errorText}</div>}

            <section className="suggestions">
              {suggestions.map((item) => (
                <button
                  key={item}
                  className="suggestion"
                  onClick={() => setMessage(item)}
                >
                  <span>{item}</span>
                  <span className="arrow">→</span>
                </button>
              ))}
            </section>

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

            {renderChatForm("conversation-input")}
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