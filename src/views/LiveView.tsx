// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useEffect, useMemo, useReducer, useState } from "react";
import ErrorBoundary from "../ErrorBoundary";
import ImageLoader from "../ImageLoader";
import {
  getIptvState,
  subscribeIptv,
  loadIptvSources,
  removePlaylistSource,
  refreshPlaylist,
} from "../iptv/store";
import {
  subscribeEpg,
  loadEpg,
  resolveNowNext,
  hasEpg,
  dropEpg,
  type NowNext,
} from "../iptv/epgStore";
import type { IptvChannel, IptvPlaylist, IptvPlaylistSource } from "../iptv/types";
import {
  subscribeFavorites,
  getFavorites,
  favoriteCount,
  isFavorite,
  toggleFavorite,
  dropFavoritesForSource,
  type FavoriteChannel,
} from "../iptv/favoritesStore";
import PlaylistForm from "./live/PlaylistForm";
import GuideView from "./live/GuideView";

/** Sentinel `selectedGroup` value for the cross-playlist favourites view. */
const FAVORITES_GROUP = "__favorites__";

/** Guide rows are heavier than grid cards (sticky cells + per-row timeline);
 *  cap them tighter than the grid so a huge category stays responsive. */
const GUIDE_MAX_ROWS = 150;
type ViewMode = "grid" | "guide";

// ---------------------------------------------------------------------------
// LiveView — Live TV (IPTV) browser. Source picker + group sidebar + search
// + channel grid OR EPG guide grid. Channels play through the normal player
// via the `onPlayChannel` callback (App wires the synthetic stream/target +
// isLive flag). Restyled to Aura's glass/spectral tokens.
//
// MEMORY: the channel grid is CAPPED to MAX_VISIBLE rendered cards and uses
// ImageLoader (IntersectionObserver lazy logos) — a provider playlist can
// carry 10k+ channels and mounting them all would churn the heap (the
// CLAUDE.md "don't mount hundreds of cards" rule). Group + search filtering
// is the primary refinement; the cap is the backstop with a "refine to see
// all" hint.
// ---------------------------------------------------------------------------

const MAX_VISIBLE = 400;

interface Props {
  active: boolean;
  onPlayChannel: (channel: IptvChannel, playlist: IptvPlaylist) => void;
}

/** Subscribe to the module-level IPTV store; re-render on every change. */
function useIptv() {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeIptv(force), []);
  return getIptvState();
}

/** A version counter that bumps whenever the EPG store changes (load /
 *  error / evict), so consumers re-resolve now/next. */
function useEpgVersion(): number {
  const [v, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeEpg(bump), []);
  return v;
}

/** Version counter that bumps on every favourites change (star/unstar). */
function useFavoritesVersion(): number {
  const [v, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeFavorites(bump), []);
  return v;
}

/** Current wall-clock ms, refreshed on an interval so now/next + progress
 *  bars advance. 30 s granularity is plenty for programme boundaries. */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function LiveView(props: Props) {
  return (
    <ErrorBoundary scope="LiveTV">
      <LiveBody {...props} />
    </ErrorBoundary>
  );
}

function LiveBody({ active, onPlayChannel }: Props) {
  const state = useIptv();
  const epgVer = useEpgVersion();
  const favVer = useFavoritesVersion();
  const nowMs = useNowTick();
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("All");
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<IptvPlaylistSource | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  // Load configured sources on first activation.
  useEffect(() => {
    if (active) void loadIptvSources();
  }, [active]);

  // Auto-select the first source once sources resolve / change.
  useEffect(() => {
    if (state.sources.length === 0) {
      setSelectedSourceId(null);
      return;
    }
    if (!selectedSourceId || !state.sources.some((s) => s.id === selectedSourceId)) {
      setSelectedSourceId(state.sources[0].id);
    }
  }, [state.sources, selectedSourceId]);

  // Reset group/search when switching source.
  useEffect(() => {
    setSelectedGroup("All");
    setQuery("");
  }, [selectedSourceId]);

  const playlist = selectedSourceId ? state.playlists.get(selectedSourceId) ?? null : null;
  const loading = selectedSourceId ? state.loading.has(selectedSourceId) : false;
  const error = selectedSourceId ? state.errors.get(selectedSourceId) ?? null : null;

  // Load the EPG for the active playlist (no-op when it has no epgUrl, or
  // when a fresh parse is already cached).
  useEffect(() => {
    if (playlist && selectedSourceId) {
      void loadEpg(selectedSourceId, playlist.epgUrl, playlist.channels);
    }
  }, [selectedSourceId, playlist]);

  const epgReady = selectedSourceId ? hasEpg(selectedSourceId) : false;

  // Group counts for the sidebar (computed once per playlist).
  const groups = useMemo(() => {
    if (!playlist) return [];
    const counts = new Map<string, number>();
    for (const ch of playlist.channels) {
      counts.set(ch.group, (counts.get(ch.group) ?? 0) + 1);
    }
    return playlist.groups
      .filter((g) => counts.has(g))
      .map((g) => ({ name: g, count: counts.get(g) ?? 0 }));
  }, [playlist]);

  // Filter channels by selected group + search query.
  const filtered = useMemo(() => {
    if (!playlist) return [];
    const q = query.trim().toLowerCase();
    let list = playlist.channels;
    if (selectedGroup !== "All") list = list.filter((c) => c.group === selectedGroup);
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
    return list;
  }, [playlist, selectedGroup, query]);

  const visible = filtered.length > MAX_VISIBLE ? filtered.slice(0, MAX_VISIBLE) : filtered;

  // Resolve now/next for the visible cards ONCE per render (not per card) —
  // keyed on the visible set, source, the 30 s now-tick, and the EPG version
  // (so it re-resolves when the EPG finishes loading). `epgVer` participates
  // only as a re-trigger. Bounded to MAX_VISIBLE entries.
  const nowNextByChannel = useMemo(() => {
    const map = new Map<string, NowNext>();
    if (!selectedSourceId || !epgReady) return map;
    for (const ch of visible) {
      const nn = resolveNowNext(selectedSourceId, ch, nowMs);
      if (nn && (nn.now || nn.next)) map.set(ch.id, nn);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedSourceId, nowMs, epgReady, epgVer]);

  // ── Favourites (cross-playlist) ──────────────────────────────────────
  const favoritesView = selectedGroup === FAVORITES_GROUP;
  const totalFavorites = useMemo(() => favoriteCount(), [favVer]);
  const favorites = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = [...getFavorites()];
    return q ? list.filter((f) => f.channel.name.toLowerCase().includes(q)) : list;
  }, [favVer, query]);

  /** Play a favourite — its origin playlist may not be the selected one, so
   *  synthesise the minimal playlist handlePlayChannel needs (it only reads
   *  `.name`). */
  const playFavorite = (fav: FavoriteChannel) => {
    onPlayChannel(fav.channel, {
      id: fav.sourceId,
      name: fav.sourceName,
      url: "",
      epgUrl: null,
      channels: [],
      fetchedAt: 0,
      groups: [],
    });
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="aura-row-title text-3xl font-semibold tracking-tight">Live TV</h1>
          <p className="text-white/35 text-sm mt-1">
            Your IPTV playlists — channels stream through the normal player.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {state.sources.length > 0 && (
            <SourcePicker
              sources={state.sources}
              selectedId={selectedSourceId}
              onSelect={setSelectedSourceId}
              onRefresh={(id) => refreshPlaylist(id, { force: true })}
              onEdit={(id) => {
                const src = state.sources.find((s) => s.id === id) ?? null;
                if (src) {
                  setEditingSource(src);
                  setFormOpen(true);
                }
              }}
              onRemove={(id) => {
                dropEpg(id);
                dropFavoritesForSource(id);
                void removePlaylistSource(id);
              }}
            />
          )}
          <button
            type="button"
            onClick={() => {
              setEditingSource(null);
              setFormOpen(true);
            }}
            className="px-3.5 h-9 rounded-xl text-[13px] font-medium border transition-colors
                       bg-ln-accent/15 text-ln-accent border-ln-accent/30 hover:bg-ln-accent/25"
          >
            + Add playlist
          </button>
        </div>
      </div>

      {/* Body */}
      {state.sources.length === 0 ? (
        <EmptyState
          loaded={state.loaded}
          onAdd={() => {
            setEditingSource(null);
            setFormOpen(true);
          }}
        />
      ) : (
        <div className="flex-1 flex min-h-0">
          {/* Category sidebar */}
          <aside
            className="w-56 flex-shrink-0 border-r border-white/8 overflow-y-auto py-2"
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
          >
            <GroupRow
              label="★ Favorites"
              count={totalFavorites}
              active={favoritesView}
              onClick={() => setSelectedGroup(FAVORITES_GROUP)}
              accent
            />
            <GroupRow
              label="All channels"
              count={playlist?.channels.length ?? 0}
              active={selectedGroup === "All"}
              onClick={() => setSelectedGroup("All")}
            />
            {groups.map((g) => (
              <GroupRow
                key={g.name}
                label={g.name}
                count={g.count}
                active={selectedGroup === g.name}
                onClick={() => setSelectedGroup(g.name)}
              />
            ))}
          </aside>

          {/* Channel area */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* Search + count + view toggle */}
            <div className="px-6 py-3 flex items-center gap-3 flex-wrap">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={favoritesView ? "Search favorites…" : "Search channels…"}
                className="h-9 w-64 max-w-full px-3 rounded-xl bg-white/5 border border-white/10
                           text-[13px] text-white/90 placeholder:text-white/30
                           focus:outline-none focus:border-ln-accent/40"
              />
              {favoritesView ? (
                <span className="text-white/35 text-xs">
                  {favorites.length.toLocaleString()} favorite{favorites.length === 1 ? "" : "s"}
                </span>
              ) : playlist ? (
                <span className="text-white/35 text-xs">
                  {filtered.length.toLocaleString()} channel{filtered.length === 1 ? "" : "s"}
                  {viewMode === "grid" && filtered.length > MAX_VISIBLE &&
                    ` · showing first ${MAX_VISIBLE} (refine to see all)`}
                  {viewMode === "guide" && filtered.length > GUIDE_MAX_ROWS &&
                    ` · guide showing first ${GUIDE_MAX_ROWS} (refine to see all)`}
                </span>
              ) : null}
              {!favoritesView && <ViewModeToggle mode={viewMode} onChange={setViewMode} />}
            </div>

            {/* Body — favourites, guide, or grid */}
            {favoritesView ? (
              <div
                className="flex-1 overflow-y-auto px-6 pb-8"
                style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
              >
                {favorites.length === 0 ? (
                  <p className="text-white/40 text-sm py-12 text-center max-w-md mx-auto">
                    {query
                      ? "No favorites match your search."
                      : "No favorites yet. Hover a channel and tap the ★ to add it here — favorites span every playlist."}
                  </p>
                ) : (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
                  >
                    {favorites.map((fav) => (
                      <ChannelCard
                        key={fav.key}
                        channel={fav.channel}
                        nowNext={resolveNowNext(fav.sourceId, fav.channel, nowMs)}
                        nowMs={nowMs}
                        onPlay={() => playFavorite(fav)}
                        favorited
                        onToggleFavorite={() =>
                          toggleFavorite(fav.sourceId, fav.sourceName, fav.channel)
                        }
                        sourceLabel={fav.sourceName}
                      />
                    ))}
                  </div>
                )}
              </div>
            ) : viewMode === "guide" ? (
              <GuideView
                channels={filtered.slice(0, GUIDE_MAX_ROWS)}
                sourceId={selectedSourceId ?? ""}
                sourceName={playlist?.name ?? selectedSourceId ?? ""}
                nowMs={nowMs}
                hasEpg={epgReady}
                onPlayChannel={(ch) => playlist && onPlayChannel(ch, playlist)}
              />
            ) : (
              <div
                className="flex-1 overflow-y-auto px-6 pb-8"
                style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
              >
                {loading && !playlist ? (
                  <GridSkeleton />
                ) : error ? (
                  <ErrorState
                    message={error}
                    onRetry={() => selectedSourceId && refreshPlaylist(selectedSourceId, { force: true })}
                  />
                ) : visible.length === 0 ? (
                  <p className="text-white/40 text-sm py-12 text-center">
                    {query ? "No channels match your search." : "No channels in this group."}
                  </p>
                ) : (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
                  >
                    {visible.map((ch) => (
                      <ChannelCard
                        key={ch.id}
                        channel={ch}
                        nowNext={nowNextByChannel.get(ch.id) ?? null}
                        nowMs={nowMs}
                        onPlay={() => playlist && onPlayChannel(ch, playlist)}
                        favorited={!!selectedSourceId && isFavorite(selectedSourceId, ch.id)}
                        onToggleFavorite={() =>
                          selectedSourceId &&
                          toggleFavorite(selectedSourceId, playlist?.name ?? selectedSourceId, ch)
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {formOpen && (
        <PlaylistForm
          editSource={editingSource}
          onClose={() => {
            setFormOpen(false);
            setEditingSource(null);
          }}
          onAdded={(id) => {
            setFormOpen(false);
            setEditingSource(null);
            setSelectedSourceId(id);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel card — square-ish logo tile + name. memo'd so group/search
// re-filters don't re-render unchanged cards.
// ---------------------------------------------------------------------------

const ChannelCard = memo(function ChannelCard({
  channel,
  nowNext,
  nowMs,
  onPlay,
  favorited,
  onToggleFavorite,
  sourceLabel,
}: {
  channel: IptvChannel;
  nowNext: NowNext | null;
  nowMs: number;
  onPlay: () => void;
  favorited: boolean;
  onToggleFavorite: () => void;
  /** Shown under the name in the favourites view (which playlist it's from). */
  sourceLabel?: string;
}) {
  const now = nowNext?.now ?? null;
  const progress =
    now && now.endMs > now.startMs
      ? Math.max(0, Math.min(1, (nowMs - now.startMs) / (now.endMs - now.startMs)))
      : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPlay}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPlay()}
      title={now ? `${channel.name} — ${now.title}` : channel.name}
      className="group relative flex flex-col items-stretch text-left rounded-xl overflow-hidden
                 border border-white/8 bg-white/[0.03] hover:bg-white/[0.07]
                 hover:border-white/15 transition-colors cursor-pointer
                 focus:outline-none focus-visible:border-ln-accent/50"
    >
      {/* Favourite toggle — visible on hover, or always when favourited.
          stopPropagation so the star doesn't trigger playback. */}
      <button
        type="button"
        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
        title={favorited ? "Remove from favorites" : "Add to favorites"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite();
        }}
        className={[
          "absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-lg flex items-center justify-center transition-all",
          favorited
            ? "opacity-100 text-amber-300 bg-black/40 hover:bg-black/55"
            : "opacity-0 group-hover:opacity-100 text-white/70 bg-black/40 hover:bg-black/55 hover:text-amber-300",
        ].join(" ")}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill={favorited ? "currentColor" : "none"}
             stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M12 2.5l2.9 6.1 6.6.9-4.8 4.7 1.2 6.6L12 18.6 6.1 21.8l1.2-6.6L2.5 9.5l6.6-.9z" />
        </svg>
      </button>

      {/* overflow-hidden + the absolutely-positioned image keep the logo
          strictly inside the 16:9 box. Without absolute positioning, a
          logo's intrinsic size can force the aspect-ratio box taller than
          16:9 (min-content), which after a playback→browse re-layout
          stretched some cards into giant tiles. */}
      <div className="relative aspect-video bg-black/40 overflow-hidden flex items-center justify-center">
        {channel.logo ? (
          <ImageLoader
            src={channel.logo}
            alt={channel.name}
            loading="lazy"
            className="absolute inset-0"
            imgClassName="w-full h-full object-contain p-3"
            fallback={<ChannelGlyph />}
          />
        ) : (
          <ChannelGlyph />
        )}
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0
                     group-hover:opacity-100 transition-opacity"
        >
          <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" className="text-white/90">
            <path d="M8 5v14l11-7z" />
          </svg>
        </span>
        {/* Live progress bar across the current programme. */}
        {progress != null && (
          <span aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-black/40">
            <span
              className="block h-full bg-ln-accent/80"
              style={{ width: `${(progress * 100).toFixed(1)}%` }}
            />
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-[12.5px] text-white/85 font-medium truncate">{channel.name}</p>
        {now ? (
          <p className="text-[10.5px] text-ln-accent/80 truncate" title={now.title}>
            {now.title}
          </p>
        ) : (
          <p className="text-[10.5px] text-white/35 truncate">{sourceLabel ?? channel.group}</p>
        )}
      </div>
    </div>
  );
});

const ChannelGlyph = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" className="text-white/20" aria-hidden>
    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
  </svg>
);

// ---------------------------------------------------------------------------
// Grid / Guide view toggle
// ---------------------------------------------------------------------------

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (m: ViewMode) => void }) {
  return (
    <div className="ml-auto flex gap-1 p-1 rounded-xl bg-white/5 border border-white/8">
      {(["grid", "guide"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onChange(m)}
          className={[
            "px-3 h-7 rounded-lg text-[12px] font-medium capitalize transition-colors",
            mode === m ? "bg-ln-accent/20 text-ln-accent" : "text-white/55 hover:text-white/85",
          ].join(" ")}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Group sidebar row
// ---------------------------------------------------------------------------

function GroupRow({
  label,
  count,
  active,
  onClick,
  accent,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** Subtle amber tint + bottom divider — marks the cross-playlist
   *  "★ Favorites" row apart from the per-playlist groups. */
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full flex items-center justify-between gap-2 px-4 h-9 text-left transition-colors",
        accent ? "border-b border-white/8 mb-1" : "",
        active
          ? accent
            ? "text-amber-300 bg-amber-300/10"
            : "text-ln-accent bg-ln-accent/10"
          : accent
            ? "text-amber-200/80 hover:text-amber-200 hover:bg-amber-300/[0.06]"
            : "text-white/60 hover:text-white/90 hover:bg-white/[0.05]",
      ].join(" ")}
    >
      <span className="text-[12.5px] font-medium truncate">{label}</span>
      <span className="text-[10.5px] text-white/30 tabular-nums flex-shrink-0">{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Source picker — current source name + a dropdown of all sources with
// per-source refresh / remove actions.
// ---------------------------------------------------------------------------

function SourcePicker({
  sources,
  selectedId,
  onSelect,
  onRefresh,
  onEdit,
  onRemove,
}: {
  sources: { id: string; name: string }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRefresh: (id: string) => void;
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = sources.find((s) => s.id === selectedId) ?? sources[0];

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="px-3.5 h-9 rounded-xl text-[13px] font-medium border transition-colors
                   bg-white/5 text-white/85 border-white/10 hover:bg-white/10 flex items-center gap-2 max-w-[240px]"
      >
        <span className="truncate">{current?.name ?? "Select playlist"}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="opacity-50 flex-shrink-0">
          <path d="M7 10l5 5 5-5z" />
        </svg>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            className="absolute right-0 mt-1 w-[280px] max-h-[60vh] overflow-y-auto z-40
                       rounded-xl border border-white/12 bg-[rgba(14,14,18,0.97)] backdrop-blur-2xl
                       shadow-glass-edge py-1"
          >
            {sources.map((s) => (
              <div
                key={s.id}
                className={[
                  "flex items-center gap-1 px-2 py-1.5 group",
                  s.id === selectedId ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelect(s.id);
                    setOpen(false);
                  }}
                  className="flex-1 min-w-0 text-left px-2 py-0.5"
                >
                  <span
                    className={[
                      "text-[13px] font-medium truncate block",
                      s.id === selectedId ? "text-ln-accent" : "text-white/85",
                    ].join(" ")}
                  >
                    {s.name}
                  </span>
                </button>
                <button
                  type="button"
                  title="Refresh"
                  onClick={() => onRefresh(s.id)}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40
                             hover:text-white/90 hover:bg-white/10 flex-shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="Edit"
                  onClick={() => {
                    onEdit(s.id);
                    setOpen(false);
                  }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40
                             hover:text-white/90 hover:bg-white/10 flex-shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="Remove"
                  onClick={() => {
                    onRemove(s.id);
                  }}
                  className="w-7 h-7 rounded-lg flex items-center justify-center text-white/40
                             hover:text-red-300 hover:bg-red-400/10 flex-shrink-0"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

function EmptyState({ loaded, onAdd }: { loaded: boolean; onAdd: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-6 gap-4">
      <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" className="text-white/30">
          <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z" />
        </svg>
      </div>
      <div>
        <p className="text-white/85 text-lg font-semibold">No playlists yet</p>
        <p className="text-white/40 text-sm mt-1 max-w-sm">
          Add an M3U playlist or Xtream login to browse and watch live channels.
        </p>
      </div>
      {loaded && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-1 px-4 h-9 rounded-xl text-[13px] font-medium
                     bg-ln-accent/15 text-ln-accent border border-ln-accent/30 hover:bg-ln-accent/25"
        >
          + Add your first playlist
        </button>
      )}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center text-center gap-3 py-16">
      <p className="text-red-300/90 text-sm max-w-md">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="px-3.5 h-9 rounded-xl text-[13px] font-medium bg-white/5 border border-white/10
                   text-white/80 hover:bg-white/10"
      >
        Retry
      </button>
    </div>
  );
}

function GridSkeleton() {
  return (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}
    >
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden border border-white/8 bg-white/[0.03]">
          <div className="aspect-video bg-white/5 animate-pulse" />
          <div className="px-2.5 py-2 space-y-1.5">
            <div className="h-3 w-3/4 rounded bg-white/5 animate-pulse" />
            <div className="h-2.5 w-1/2 rounded bg-white/5 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
