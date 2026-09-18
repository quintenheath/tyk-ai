import { useEffect, useRef, useState } from "react";
import { askTyk, toHistory } from "../utils/ask";
import { appendMessage, createConversation } from "../utils/conversations";

// Continuous 2-way voice loop, bound to one conversation. Every turn is
// persisted as a real message (metadata.mode = "voice") so it becomes part
// of that conversation's permanent transcript, not a side channel.
function CallOverlay({
  conversationId,
  messages,
  identity,
  onConversationCreated,
  onMessageAppended,
  onClose,
}) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("Tap the mic to start the call");
  const [liveTurns, setLiveTurns] = useState([]);
  const [supported, setSupported] = useState(true);
  const [errorText, setErrorText] = useState("");

  const recognitionRef = useRef(null);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  const activeRef = useRef(false);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition || !window.speechSynthesis) {
      setSupported(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      handleTurn(transcript);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") {
        if (activeRef.current) recognition.start();
        return;
      }
      console.error("Speech recognition error:", event.error);
      setErrorText("Didn't catch that - tap the mic to try again.");
      setStatus("Tap the mic to resume the call");
    };

    recognitionRef.current = recognition;
    return () => recognition.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleTurn(transcript) {
    setStatus("Thinking…");
    setErrorText("");
    setLiveTurns((prev) => [...prev, { role: "user", content: transcript }]);

    try {
      let convId = conversationIdRef.current;

      if (!convId) {
        const { conversation, message: userMessage } = await createConversation({
          role: "user",
          content: transcript,
          metadata: { mode: "voice" },
        }, identity);
        convId = conversation.id;
        conversationIdRef.current = convId;
        onConversationCreated(conversation, userMessage);
      } else {
        const { message: userMessage } = await appendMessage(convId, {
          role: "user",
          content: transcript,
          metadata: { mode: "voice" },
        }, identity);
        onMessageAppended(userMessage);
      }

      const history = toHistory(messagesRef.current);
      const { answer, sources, conversationMeta } = await askTyk({ question: transcript, history, conversationId: convId });

      const { message: assistantMessage } = await appendMessage(convId, {
        role: "assistant",
        content: answer,
        metadata: { mode: "voice", sources, conversationMeta },
      }, identity);
      onMessageAppended(assistantMessage);
      setLiveTurns((prev) => [...prev, { role: "assistant", content: answer }]);

      speak(answer);
    } catch (err) {
      console.error("Call turn failed:", err);
      setErrorText("Something went wrong on that turn. Tap the mic to continue.");
      setStatus("Tap the mic to resume the call");
    }
  }

  function speak(text) {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      if (activeRef.current) {
        setStatus("Listening…");
        recognitionRef.current?.start();
      }
    };
    window.speechSynthesis.speak(utterance);
  }

  function startCall() {
    setActive(true);
    activeRef.current = true;
    setStatus("Listening…");
    recognitionRef.current?.start();
  }

  function endCall() {
    setActive(false);
    activeRef.current = false;
    window.speechSynthesis.cancel();
    recognitionRef.current?.stop();
    setStatus("Call ended");
  }

  return (
    <div className="call-overlay">
      <div className="call-overlay-panel">
        <div className="call-overlay-header">
          <h2>📞 Call TYK</h2>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        {!supported ? (
          <div className="voice-unsupported">
            Calls need a browser with speech recognition support (Chrome or
            Edge on desktop/Android).
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={active ? endCall : startCall}
              className={"voice-mic" + (active ? " listening" : "")}
            >
              {active ? "●" : "🎙"}
            </button>
            <div className="call-status">{status}</div>
            {errorText && <div className="inline-error">{errorText}</div>}

            <div className="call-transcript">
              {liveTurns.map((turn, i) => (
                <div className={`message message-${turn.role}`} key={i}>
                  <div className="message-label">
                    {turn.role === "assistant" ? "TYK" : "You"}
                  </div>
                  <div className="message-text">{turn.content}</div>
                </div>
              ))}
            </div>

            <p className="call-hint">
              Everything said is saved to this conversation's transcript.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

export default CallOverlay;
