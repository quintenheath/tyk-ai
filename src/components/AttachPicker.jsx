import { useEffect, useState } from "react";
import { listDocuments } from "../utils/documents";

function AttachPicker({ selectedIds, onToggle, onClose }) {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listDocuments()
      .then((docs) => setDocuments(docs.filter((d) => d.status === "indexed")))
      .catch((err) => console.error("Failed to load documents:", err))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="attach-picker">
      <div className="attach-picker-header">
        <span>Attach a document</span>
        <button type="button" onClick={onClose}>
          ✕
        </button>
      </div>

      {loading && <div className="attach-picker-empty">Loading…</div>}

      {!loading && documents.length === 0 && (
        <div className="attach-picker-empty">
          No indexed documents yet. Upload one in Documents first.
        </div>
      )}

      {documents.map((doc) => (
        <label className="attach-picker-item" key={doc.id}>
          <input
            type="checkbox"
            checked={selectedIds.includes(doc.id)}
            onChange={() => onToggle(doc)}
          />
          {doc.name}
        </label>
      ))}
    </div>
  );
}

export default AttachPicker;
