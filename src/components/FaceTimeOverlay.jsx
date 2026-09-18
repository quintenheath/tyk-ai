import { useEffect, useRef, useState } from "react";
import { askTyk, toHistory } from "../utils/ask";
import { appendMessage, createConversation } from "../utils/conversations";

// Live video call, bound to one conversation: the camera feed stays live the
// whole time (no manual capture/retake step) while continuous speech
// recognition listens for what the person says. Each time they finish a
// sentence, TYK grabs the CURRENT frame from the live feed at that instant,
// sends it together with what was just said, and speaks its answer back -
// so it's really seeing through the camera and reacting to what's said, not
// a single photo + typed question. Every turn is still persisted as a real
// message (metadata.mode = "vision") into the conversation transcript.
function FaceTimeOverlay({
  conversationId,
  messages,
  identity,
  onConversationCreated,
  onMessageAppended,
  onClose,
}) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const conversationIdRef = useRef(conversationId);
  const messagesRef = useRef(messages);
  const recognitionRef = useRef(null);
  const activeRef = useRef(false);

  const [cameraError, setCameraError] = useState("");
  const [supported, setSupported] = useState(true);
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("Tap the camera to start FaceTime");
  const [errorText, setErrorText] = useState("");
  const [turns, setTurns] = useState([]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    startCamera();
    return () => streamRef.current?.getTracks().forEach((t) => t.stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      setErrorText("Didn't catch that - tap the camera to resume.");
      setStatus("Tap the camera to resume FaceTime");
    };

    recognitionRef.current = recognition;
    return () => recognition.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      // A stale play() call getting aborted by a newer one (e.g. React
      // StrictMode's double-invoked effects in dev) isn't a real camera
      // failure - only surface genuine permission/device errors.
      if (err.name === "AbortError") return;
      console.error("Camera access failed:", err);
      setCameraError(
        "Couldn't access the camera. Please allow camera permissions.",
      );
    }
  }

  // Grabs whatever the camera is seeing RIGHT NOW - called at the instant a
  // spoken sentence finishes, so TYK reacts to the live feed, not a stale
  // photo taken earlier in the call.
  function captureCurrentFrame() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return null;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  }

  async function handleTurn(transcript) {
    setStatus("Thinking…");
    setErrorText("");
    setTurns((prev) => [...prev, { role: "user", content: transcript }]);

    const frame = captureCurrentFrame();

    try {
      let convId = conversationIdRef.current;

      if (!convId) {
        const { conversation, message: userMessage } = await createConversation({
          role: "user",
          content: transcript,
          metadata: { mode: "vision", attachments: frame ? ["Live camera frame"] : [] },
        }, identity);
        convId = conversation.id;
        conversationIdRef.current = convId;
        onConversationCreated(conversation, userMessage);
      } else {
        const { message: userMessage } = await appendMessage(convId, {
          role: "user",
          content: transcript,
          metadata: { mode: "vision", attachments: frame ? ["Live camera frame"] : [] },
        }, identity);
        onMessageAppended(userMessage);
      }

      const history = toHistory(messagesRef.current);
      const { answer, sources, conversationMeta } = await askTyk({
        question: transcript,
        images: frame ? [{ mimeType: "image/jpeg", base64: frame }] : [],
        history,
        conversationId: convId,
      });

      const { message: assistantMessage } = await appendMessage(convId, {
        role: "assistant",
        content: answer,
        metadata: { mode: "vision", sources, conversationMeta },
      }, identity);
      onMessageAppended(assistantMessage);
      setTurns((prev) => [...prev, { role: "assistant", content: answer }]);

      speak(answer);
    } catch (err) {
      console.error("FaceTime turn failed:", err);
      setErrorText("Something went wrong on that turn. Tap the camera to continue.");
      setStatus("Tap the camera to resume FaceTime");
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
    setStatus("Speaking…");
    window.speechSynthesis.speak(utterance);
  }

  function startFaceTime() {
    setActive(true);
    activeRef.current = true;
    setStatus("Listening…");
    recognitionRef.current?.start();
  }

  function endFaceTime() {
    setActive(false);
    activeRef.current = false;
    window.speechSynthesis.cancel();
    recognitionRef.current?.stop();
    setStatus("FaceTime ended");
  }

  return (
    <div className="call-overlay">
      <div className="call-overlay-panel facetime-panel">
        <div className="call-overlay-header">
          <h2>🎥 FaceTime TYK</h2>
          <button type="button" onClick={onClose}>
            ✕
          </button>
        </div>

        {cameraError && <div className="inline-error">{cameraError}</div>}
        {!supported && (
          <div className="voice-unsupported">
            Live FaceTime needs a browser with speech recognition support
            (Chrome or Edge on desktop/Android).
          </div>
        )}

        <div className="vision-camera" onClick={() => (active ? endFaceTime() : startFaceTime())}>
          <video ref={videoRef} className="vision-video" muted playsInline />
          <canvas ref={canvasRef} hidden />
          {supported && (
            <div className={"facetime-live-badge" + (active ? " on" : "")}>
              {active ? "● LIVE" : "Tap to start"}
            </div>
          )}
        </div>

        <div className="call-status">{status}</div>
        {errorText && <div className="inline-error">{errorText}</div>}

        <div className="call-transcript">
          {turns.map((turn, i) => (
            <div className={`message message-${turn.role}`} key={i}>
              <div className="message-label">
                {turn.role === "assistant" ? "TYK" : "You"}
              </div>
              <div className="message-text">{turn.content}</div>
            </div>
          ))}
        </div>

        <p className="call-hint">
          TYK sees the live camera feed and hears what you say - every turn is
          saved to this conversation's transcript.
        </p>
      </div>
    </div>
  );
}

export default FaceTimeOverlay;

