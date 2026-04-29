import { useState, useEffect, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { MetaPreview } from "./types";

export type { MetaPreview };

interface Props {
  addonUrl: string | null;
  catalogType: string | null;
  catalogId: string | null;
}

// ---------------------------------------------------------------------------
// PosterCard
// ---------------------------------------------------------------------------

const PosterCard = memo(function PosterCard({ meta }: { meta: MetaPreview }) {
  const [imgError, setImgError] = useState(false);
  const showImage = meta.poster && !imgError;

  return (
    <div className="group flex flex-col gap-2 card-contain">
      <div
        className="relative overflow-hidden rounded-xl bg-white/5 border border-white/8"
        style={{ aspectRatio: "2 / 3" }}
      >
        {showImage ? (
          <img
            src={meta.poster!}
            alt={meta.name}
            loading="lazy"
            decoding="async"
            onError={() => setImgError(true)}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white/20">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M18 4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4h-4z" />
            </svg>
          </div>
        )}
      </div>

      <div className="px-0.5">
        <p className="text-white/85 text-sm font-medium leading-tight line-clamp-2 text-center">{meta.name}</p>
        {meta.release_info && (
          <p className="text-white/40 text-xs mt-0.5 text-center">{meta.release_info}</p>
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// CatalogGrid — driven entirely by props; fetches when they change
// ---------------------------------------------------------------------------

export default function CatalogGrid({ addonUrl, catalogType, catalogId }: Props) {
  const [items, setItems] = useState<MetaPreview[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!addonUrl || !catalogType || !catalogId) {
      setItems([]);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    invoke<MetaPreview[]>("fetch_catalog", {
      addonUrl,
      catalogType,
      catalogId,
    })
      .then((results) => { if (!cancelled) setItems(results); })
      .catch((e) => { if (!cancelled) { setError(String(e)); setItems([]); } })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [addonUrl, catalogType, catalogId]);

  if (!addonUrl) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-white/25 h-full">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <path d="M4 8h4V4H4v4zm6 12h4v-4h-4v4zm-6 0h4v-4H4v4zm0-6h4v-4H4v4zm6 0h4v-4h-4v4zm6-10v4h4V4h-4zm-6 4h4V4h-4v4zm6 6h4v-4h-4v4zm0 6h4v-4h-4v4z" />
        </svg>
        <p className="text-sm">Select a source from the sidebar</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Loading bar */}
      {loading && (
        <div className="h-px flex-shrink-0 bg-gradient-to-r from-transparent via-ln-accent to-transparent animate-pulse" />
      )}

      {/* Error */}
      {error && (
        <div className="flex-shrink-0 mx-5 mt-4 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3">
          <p className="text-red-400/90 text-sm font-mono">{error}</p>
        </div>
      )}

      {/* Grid */}
      {items.length > 0 && (
        <div
          className="flex-1 overflow-y-auto p-5"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
        >
          <div className="grid gap-5"
               style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
            {items.map((meta) => (
              <PosterCard key={meta.id} meta={meta} />
            ))}
          </div>
        </div>
      )}

      {/* Empty state (not loading, no error, no items) */}
      {!loading && !error && items.length === 0 && addonUrl && (
        <div className="flex-1 flex items-center justify-center text-white/25 text-sm">
          No items found in this catalog.
        </div>
      )}
    </div>
  );
}
