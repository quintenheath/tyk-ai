import { useEffect, useRef, useState } from "react";
import { supabase } from "../utils/supabase";
import { uploadDocument } from "../utils/documents";

function ownerParams(identity) {
  return { token: identity?.token };
}

async function invokeTeachTyk(payload) {
  const { data, error } = await supabase.functions.invoke("teach-tyk", {
    body: payload,
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data;
}

function TeachTykView({ identity }) {
  const [current, setCurrent] = useState(null);
  const [history, setHistory] = useState([]);
  const [coverage, setCoverage] = useState([]);
  const [answer, setAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [errorText, setErrorText] = useState("");
  const [learnedBanner, setLearnedBanner] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);

  useEffect(() => {
    loadNext();
    loadHistory();
    loadCoverage();

    // Live shared knowledge: when another user (or Teach TYK itself,
    // elsewhere) confirms a fact, this view's coverage refreshes without a
    // manual reload - the DB stays the single source of truth.
    const channel = supabase
      .channel("teach-tyk-live")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "knowledge_facts" },
        () => loadCoverage(),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showLearned(learned) {
    if (!learned) return;
    setLearnedBanner(
      `Knowledge expanded: ${learned.entityName} \u2192 ${(learned.factKey || "").replace(/_/g, " ")}`,
    );
    setTimeout(() => setLearnedBanner(""), 4000);
  }

  async function loadNext() {
    setLoading(true);
    setErrorText("");
    try {
      const { entry } = await invokeTeachTyk({
        action: "next-question",
        ...ownerParams(identity),
      });
      setCurrent(entry);
    } catch (err) {
      console.error("Failed to load next question:", err);
      setErrorText("TYK couldn't come up with a question right now. Try again.");
    } finally {
      setLoading(false);
    }
  }

  async function loadHistory() {
    try {
      const { entries } = await invokeTeachTyk({ action: "list" });
      setHistory((entries || []).filter((e) => e.status === "answered"));
    } catch (err) {
      console.error("Failed to load learning history:", err);
    }
  }

  async function loadCoverage() {
    try {
      const { entities } = await invokeTeachTyk({ action: "coverage" });
      setCoverage(entities || []);
    } catch (err) {
      console.error("Failed to load knowledge coverage:", err);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!answer.trim() || !current || submitting) return;
    await submitAnswer(answer.trim());
  }

  async function submitAnswer(text) {
    setSubmitting(true);
    setErrorText("");
    try {
      const { entry, learned } = await invokeTeachTyk({
        action: "answer",
        entry_id: current.id,
        answer: text,
        ...ownerParams(identity),
      });
      setAnswer("");
      setCurrent(entry);
      showLearned(learned);
      loadHistory();
      loadCoverage();
    } catch (err) {
      console.error("Failed to save answer:", err);
      setErrorText("Couldn't save that answer. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!current || submitting) return;
    setSubmitting(true);
    try {
      const { entry } = await invokeTeachTyk({
        action: "skip",
        entry_id: current.id,
        ...ownerParams(identity),
      });
      setCurrent(entry);
    } catch (err) {
      console.error("Failed to skip question:", err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !current) return;

    setUploading(true);
    setErrorText("");
    try {
      const document = await uploadDocument(file, identity);
      const meta = current.metadata || {};
      const { entry, learned } = await invokeTeachTyk({
        action: "attach-document",
        entry_id: current.id,
        entity_id: meta.entityId,
        fact_key: meta.factKey,
        document_id: document.id,
        document_name: document.name,
        ...ownerParams(identity),
      });
      setCurrent(entry);
      showLearned(learned || { entityName: meta.entityName, factKey: meta.factKey });
      loadHistory();
      loadCoverage();
    } catch (err) {
      console.error("Failed to attach document:", err);
      setErrorText("Couldn't upload that file. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  // Multimodal: photo upload for a "can you upload a picture of X" question.
  // Mirrors document-manager's signed-upload pattern but writes into the
  // private tyk-teach-images bucket via teach-tyk's own actions. Shared by
  // both the file-picker path and the live camera-capture path below.
  async function uploadImageBlob(blob, fileName, fileType) {
    if (!current) return;
    setUploading(true);
    setErrorText("");
    try {
      const meta = current.metadata || {};
      const { uploadUrl, path } = await invokeTeachTyk({
        action: "request-image-upload",
        file_name: fileName,
        file_type: fileType,
        ...ownerParams(identity),
      });

      const putResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": fileType || "application/octet-stream" },
        body: blob,
      });
      if (!putResponse.ok) throw new Error("Failed to upload photo to storage.");

      const { entry, learned } = await invokeTeachTyk({
        action: "confirm-image-upload",
        entry_id: current.id,
        entity_id: meta.entityId,
        fact_key: meta.factKey,
        entity_name: meta.entityName,
        image_path: path,
        ...ownerParams(identity),
      });
      setCurrent(entry);
      showLearned(learned);
      loadHistory();
      loadCoverage();
    } catch (err) {
      console.error("Failed to upload photo:", err);
      setErrorText("Couldn't upload that photo. Please try again.");
    } finally {
      setUploading(false);
    }
  }

  function handleImageUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    uploadImageBlob(file, file.name, file.type);
  }

  // Live camera capture, reusing the same getUserMedia + canvas-frame
  // pattern as FaceTime - lets someone photograph the actual hardware right
  // from the browser instead of needing an existing file to pick.
  async function openCamera() {
    setErrorText("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      setCameraOpen(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Camera access failed:", err);
      setErrorText("Couldn't access the camera. Please allow camera permissions.");
    }
  }

  function closeCamera() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setCameraOpen(false);
  }

  function captureFromCamera() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      closeCamera();
      if (blob) uploadImageBlob(blob, `capture-${Date.now()}.jpg`, "image/jpeg");
    }, "image/jpeg", 0.85);
  }

  // Multimodal: yes/no confirmation on an existing photo TYK already has.
  async function handleImageConfirm(yesNo) {
    if (!current || submitting) return;
    await submitAnswer(yesNo);
  }

  // Multimodal: choosing the correct match among several candidate photos.
  async function handleChooseImage(imageId) {
    if (!current || submitting) return;
    setSubmitting(true);
    setErrorText("");
    try {
      const meta = current.metadata || {};
      const { entry, learned } = await invokeTeachTyk({
        action: "choose-image",
        entry_id: current.id,
        entity_id: meta.entityId,
        fact_key: meta.factKey,
        entity_name: meta.entityName,
        chosen_image_id: imageId,
        image_ids: (meta.images || []).map((img) => img.id),
        ...ownerParams(identity),
      });
      setCurrent(entry);
      showLearned(learned);
      loadHistory();
      loadCoverage();
    } catch (err) {
      console.error("Failed to record image choice:", err);
      setErrorText("Couldn't save that choice. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const kind = current?.metadata?.kind;

  return (
    <main className="teach-main">
      <div className="teach-header">
        <h1>Teach TYK</h1>
        <p>
          TYK is continuously learning how Tykel operates - with text,
          photos, and documents. Only what you confirm here becomes
          permanent company knowledge, shared with every authorized user.
        </p>
      </div>

      {errorText && <div className="inline-error">{errorText}</div>}
      {learnedBanner && <div className="teach-learned-banner">{learnedBanner}</div>}

      <div className="teach-question-card">
        <div className="teach-question-label">TYK asks</div>
        {loading ? (
          <div className="teach-question-text">TYK is learning…</div>
        ) : (
          <div className="teach-question-text">{current?.question}</div>
        )}

        {kind === "image_confirm" && current?.metadata?.imageUrl && (
          <div className="teach-image-block">
            <img className="teach-question-image" src={current.metadata.imageUrl} alt="Reference" />
            <div className="teach-answer-actions">
              <button
                type="button"
                className="teach-skip-button"
                onClick={() => handleImageConfirm("no")}
                disabled={submitting}
              >
                No
              </button>
              <button
                type="button"
                className="send-button teach-yes-button"
                onClick={() => handleImageConfirm("yes")}
                disabled={submitting}
              >
                Yes
              </button>
            </div>
          </div>
        )}

        {kind === "multi_image_choice" && current?.metadata?.images?.length > 0 && (
          <div className="teach-image-grid">
            {current.metadata.images.map((img) => (
              <button
                type="button"
                key={img.id}
                className="teach-image-choice"
                onClick={() => handleChooseImage(img.id)}
                disabled={submitting || !img.url}
              >
                {img.url && <img src={img.url} alt="Candidate" />}
              </button>
            ))}
          </div>
        )}

        {kind === "image_upload" && !cameraOpen && (
          <div className="teach-upload-row">
            <label className="upload-button teach-upload-label">
              {uploading ? "Uploading…" : "📷 Upload photo"}
              <input
                type="file"
                accept="image/*"
                hidden
                disabled={uploading}
                onChange={handleImageUpload}
              />
            </label>
            <button
              type="button"
              className="upload-button teach-camera-button"
              onClick={openCamera}
              disabled={uploading}
            >
              📸 Use camera
            </button>
          </div>
        )}

        {kind === "image_upload" && cameraOpen && (
          <div className="teach-camera-block">
            <div className="vision-camera">
              <video ref={videoRef} className="vision-video" muted playsInline />
              <canvas ref={canvasRef} hidden />
            </div>
            <div className="teach-answer-actions">
              <button type="button" className="teach-skip-button" onClick={closeCamera}>
                Cancel
              </button>
              <button
                type="button"
                className="send-button teach-yes-button"
                onClick={captureFromCamera}
                disabled={uploading}
              >
                {uploading ? "Uploading…" : "Capture"}
              </button>
            </div>
          </div>
        )}

        {kind === "upload_prompt" && (
          <div className="teach-upload-row">
            <label className="upload-button teach-upload-label">
              {uploading ? "Uploading…" : "📄 Upload PDF"}
              <input
                type="file"
                accept="application/pdf,.pdf,text/plain,.txt"
                hidden
                disabled={uploading}
                onChange={handleUpload}
              />
            </label>
          </div>
        )}

        {kind !== "image_confirm" && kind !== "multi_image_choice" && (
          <form className="teach-answer-form" onSubmit={handleSubmit}>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={
                kind === "upload_prompt" || kind === "image_upload"
                  ? "Or type a note instead of uploading…"
                  : "Type your answer…"
              }
              rows="3"
              disabled={loading || submitting}
            />
            <div className="teach-answer-actions">
              <button
                type="button"
                className="teach-skip-button"
                onClick={handleSkip}
                disabled={loading || submitting}
              >
                Skip
              </button>
              <button
                type="submit"
                className="send-button"
                disabled={loading || submitting || !answer.trim()}
              >
                {submitting ? "…" : "↑"}
              </button>
            </div>
          </form>
        )}
      </div>

      {history.length > 0 && (
        <div className="teach-history">
          <div className="teach-history-label">What TYK has learned</div>
          {history.map((entry) => (
            <div className="teach-history-item" key={entry.id}>
              <div className="teach-history-question">{entry.question}</div>
              <div className="teach-history-answer">{entry.answer}</div>
            </div>
          ))}
        </div>
      )}

      {coverage.length > 0 && (
        <div className="teach-history">
          <div className="teach-history-label">Knowledge coverage</div>
          {coverage.map((entity) => (
            <div className="coverage-card" key={entity.id}>
              <div className="coverage-name">
                {entity.name}
                <span className="document-tag">{entity.entity_type}</span>
              </div>
              <div className="coverage-facts">
                {(entity.knowledge_facts || []).map((fact) => (
                  <span
                    key={fact.fact_key}
                    className={
                      "coverage-fact" +
                      (fact.status === "confirmed" ? " coverage-fact-known" : "")
                    }
                  >
                    {fact.status === "confirmed" ? "\u2713" : "\u2717"}{" "}
                    {fact.fact_key.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

export default TeachTykView;

