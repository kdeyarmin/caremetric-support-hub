import { useEffect, useState } from "react";
import { publicationId } from "./publicationProtocol";
import "./publication.css";

export function PublicationVideo({ revisionId, title, locale }: { revisionId: string; title: string; locale: string }) {
  const [info, setInfo] = useState<{ hasCaptions: boolean; hasTranscript: boolean } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    async function load() {
      try {
        publicationId.parse(revisionId);
        const response = await fetch(`/api/publications/media/${revisionId}`, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort.signal });
        if (!response.ok) throw new Error("Media unavailable");
        const data: unknown = await response.json();
        if (!data || typeof data !== "object" || Object.keys(data).sort().join(",") !== "contentType,hasCaptions,hasTranscript"
          || !("contentType" in data) || data.contentType !== "video/mp4" || !("hasCaptions" in data) || typeof data.hasCaptions !== "boolean"
          || !("hasTranscript" in data) || typeof data.hasTranscript !== "boolean") throw new Error("Invalid media response");
        if (!abort.signal.aborted) { setInfo({ hasCaptions: data.hasCaptions, hasTranscript: data.hasTranscript }); setUnavailable(false); }
      } catch { if (!abort.signal.aborted) { setInfo(null); setUnavailable(true); } }
    }
    void load(); return () => abort.abort();
  }, [revisionId]);
  if (unavailable) return <p role="status">Video unavailable. It may have been retired, or your account may not have access.</p>;
  if (!info) return <p role="status">Checking video access…</p>;
  return <div><video className="publication-video" controls preload="metadata" aria-label={title} src={`/api/publications/media/${revisionId}/primary`} onError={() => setUnavailable(true)}>
    {info.hasCaptions && <track kind="captions" src={`/api/publications/media/${revisionId}/captions`} srcLang={locale.split("-")[0]} label={locale} default />}
  </video>{info.hasTranscript && <a className="text-link" href={`/api/publications/media/${revisionId}/transcript`}>Read transcript</a>}</div>;
}
