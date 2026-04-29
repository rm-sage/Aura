import { useState, memo } from "react";
import type { MetaPreview } from "./CatalogGrid";

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

interface Props {
  query: string;
  results: MetaPreview[];
  loading: boolean;
}

export default function SearchResultsGrid({ query, results, loading }: Props) {
  return (
    <div className="flex flex-col h-full overflow-hidden">
      {loading && (
        <div className="h-px flex-shrink-0 bg-gradient-to-r from-transparent via-ln-accent to-transparent animate-pulse" />
      )}

      <div className="flex-shrink-0 px-5 pt-4 pb-2">
        <p className="text-white/40 text-xs">
          {loading
            ? `Searching for "${query}"…`
            : `${results.length} result${results.length !== 1 ? "s" : ""} for "${query}"`}
        </p>
      </div>

      {results.length > 0 && (
        <div
          className="flex-1 overflow-y-auto px-5 pb-5"
          style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.1) transparent" }}
        >
          <div
            className="grid gap-5"
            style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}
          >
            {results.map((meta) => (
              <PosterCard key={meta.id} meta={meta} />
            ))}
          </div>
        </div>
      )}

      {!loading && results.length === 0 && (
        <div className="flex-1 flex items-center justify-center text-white/25 text-sm">
          No results found.
        </div>
      )}
    </div>
  );
}
