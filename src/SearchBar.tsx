import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AddonEntry } from "./types";
import type { MetaPreview } from "./CatalogGrid";

interface Props {
  addons: AddonEntry[];
  onResults: (results: MetaPreview[], query: string) => void;
  onSearching: (loading: boolean) => void;
  onClear: () => void;
}

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

// Debounced search bar — fires global_search 300 ms after the user stops typing.
// The debounce prevents hammering community addon APIs and avoids rate-limit
// bans. The addons list is captured via a ref so stale closure issues don't
// cause the wrong addon list to be sent to the backend.
export default function SearchBar({ addons, onResults, onSearching, onClear }: Props) {
  const [query, setQuery] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addonsRef = useRef(addons);
  useEffect(() => { addonsRef.current = addons; }, [addons]);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);

    if (!query.trim()) {
      onClear();
      return;
    }

    onSearching(true);
    timer.current = setTimeout(async () => {
      try {
        const results = await invoke<MetaPreview[]>("global_search", {
          addons: addonsRef.current,
          query: query.trim(),
        });
        onResults(results, query.trim());
      } catch {
        onResults([], query.trim());
      } finally {
        onSearching(false);
      }
    }, 300);

    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative flex items-center">
      <span className="absolute left-3 text-white/30 pointer-events-none">
        <SearchIcon />
      </span>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
        placeholder="Search all sources…"
        spellCheck={false}
        className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-2
                   text-white/85 text-sm placeholder:text-white/25 outline-none
                   focus:border-white/25 transition-colors"
        aria-label="Global search"
      />
    </div>
  );
}
