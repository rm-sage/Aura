// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState } from "react";
import ErrorBoundary from "../ErrorBoundary";
import ImageLoader from "../ImageLoader";
import {
  getIptvState,
  subscribeIptv,
  loadIptvSources,
  removePlaylistSource,
  refreshPlaylist,
  setDefaultPlaylist,
} from "../iptv/store";
import {
  subscribeEpg,
  loadEpg,
  resolveNowNext,
  hasEpg,
  isEpgLoading,
  epgError,
  epgTruncated,
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
} from "../iptv/favoritesStore";
import PlaylistForm from "./live/PlaylistForm";
import GuideView from "./live/GuideView";
import MultiView from "./live/MultiView";
import { openChannelMenu } from "../iptv/channelMenu";
import { useIdleGatedInterval } from "../useIdleGate";
import { SegmentedControl } from "../settingsControls";
import { sheet } from "../glassSheet";
import { useListDroplet } from "../glassListDroplet";

/** Guide rows are heavier than grid cards (sticky cells + per-row timeline);
 *  the guide starts at this many rows and grows by GUIDE_PAGE as the user
 *  scrolls to the bottom — so a huge category stays responsive but is never
 *  hard-capped. */
const GUIDE_MAX_ROWS = 150;
const GUIDE_PAGE = 50;
type ViewMode = "grid" | "guide" | "multiview";

// Session-sticky reveal counts for the guide's infinite scroll, keyed by
// `${sourceId}::${group}`. Lets a user's scroll depth survive tab switches and
// LiveView remounts within a run (their "cache until the app is restarted"); a
// genuine restart starts every group fresh at GUIDE_MAX_ROWS. Bounded + LRU so
// a provider with thousands of groups can't leak the map (CLAUDE.md cache rule).
const guideRevealCache = new Map<string, number>();
const GUIDE_REVEAL_CACHE_CAP = 256;
function readGuideReveal(key: string): number {
  return guideRevealCache.get(key) ?? GUIDE_MAX_ROWS;
}
function writeGuideReveal(key: string, n: number) {
  guideRevealCache.delete(key); // re-insert as freshest for LRU eviction
  guideRevealCache.set(key, n);
  if (guideRevealCache.size > GUIDE_REVEAL_CACHE_CAP) {
    const oldest = guideRevealCache.keys().next().value;
    if (oldest !== undefined) guideRevealCache.delete(oldest);
  }
}

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
  /** True when the main player covers Live TV — suspends Multiview tiles. */
  playerActive?: boolean;
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
 *  bars advance. 30 s granularity is plenty for programme boundaries. Idle-
 *  gated: the EPG now/next re-scan pauses while the window is minimized /
 *  occluded and snaps forward the moment it is restored. */
function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useIdleGatedInterval(() => setNow(Date.now()), intervalMs, { runOnResume: true });
  return now;
}

export default function LiveView(props: Props) {
  return (
    <ErrorBoundary scope="LiveTV">
      <LiveBody {...props} />
    </ErrorBoundary>
  );
}

function LiveBody({ active, playerActive, onPlayChannel }: Props) {
  const state = useIptv();
  const epgVer = useEpgVersion();
  const favVer = useFavoritesVersion();
  const nowMs = useNowTick();
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<string>("All");
  // Cross-playlist favourites view — kept as its OWN flag (not a sentinel
  // group name) so it can't collide with a real provider group and so a
  // source switch / removal doesn't silently dismiss it.
  const [favoritesView, setFavoritesView] = useState(false);
  // The group rail is a glass sheet; its rows share ONE hover droplet.
  const groupDroplet = useListDroplet<HTMLElement>(".aura-sheet-row");
  const [query, setQuery] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingSource, setEditingSource] = useState<IptvPlaylistSource | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("grid");

  // Load configured sources on first activation.
  useEffect(() => {
    if (active) void loadIptvSources();
  }, [active]);

  // Auto-select on first load (or when the current selection disappears):
  // the configured default playlist if it still exists, else the first.
  useEffect(() => {
    if (state.sources.length === 0) {
      setSelectedSourceId(null);
      return;
    }
    if (!selectedSourceId || !state.sources.some((s) => s.id === selectedSourceId)) {
      const def =
        state.defaultId && state.sources.some((s) => s.id === state.defaultId)
          ? state.defaultId
          : state.sources[0].id;
      setSelectedSourceId(def);
    }
  }, [state.sources, selectedSourceId, state.defaultId]);

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

  // Re-derived each render; the component re-renders on EPG store changes via
  // useEpgVersion(), so these track load start/finish.
  const epgReady = selectedSourceId ? hasEpg(selectedSourceId) : false;
  const epgLoading = selectedSourceId ? isEpgLoading(selectedSourceId) : false;
  // The EPG fetch/parse error (if any) for this source, and whether its body
  // was truncated at the size cap — both surfaced in the guide so a failure
  // isn't hidden behind the generic "no EPG loaded" copy.
  const epgErr = selectedSourceId ? epgError(selectedSourceId) : null;
  const epgIsTruncated = selectedSourceId ? epgTruncated(selectedSourceId) : false;

  // Force-reload this source's EPG (wired to the guide's Retry button).
  const retryEpg = useCallback(() => {
    if (selectedSourceId && playlist) {
      void loadEpg(selectedSourceId, playlist.epgUrl, playlist.channels, { force: true });
    }
  }, [selectedSourceId, playlist]);

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

  // The lists re-filter at a lower priority than the keystroke (as History
  // does), so typing stays immediate on a 10k+ channel playlist.
  const deferredQuery = useDeferredValue(query);

  // Filter channels by selected group + search query.
  const filtered = useMemo(() => {
    if (!playlist) return [];
    const q = deferredQuery.trim().toLowerCase();
    let list = playlist.channels;
    if (selectedGroup !== "All") list = list.filter((c) => c.group === selectedGroup);
    if (q) list = list.filter((c) => c.name.toLowerCase().includes(q));
    return list;
  }, [playlist, selectedGroup, deferredQuery]);

  // Memoized: a fresh slice every render re-ran the now/next resolve below on
  // every render (a keystroke, a favourite toggle), not only on its own keys.
  const visible = useMemo(
    () => (filtered.length > MAX_VISIBLE ? filtered.slice(0, MAX_VISIBLE) : filtered),
    [filtered],
  );

  // ── Guide infinite scroll ────────────────────────────────────────────
  // Reveal count is sticky per source+group (see guideRevealCache). It is NOT
  // keyed on the search query: searching narrows `filtered`, the slice clamps,
  // and clearing the search restores the group's depth.
  const guideKey = `${selectedSourceId ?? ""}::${selectedGroup}`;
  const [guideReveal, setGuideReveal] = useState(() => readGuideReveal(guideKey));
  useEffect(() => {
    setGuideReveal(readGuideReveal(guideKey));
  }, [guideKey]);
  const revealMoreGuide = useCallback(() => {
    setGuideReveal((n) => {
      const next = n + GUIDE_PAGE;
      writeGuideReveal(guideKey, next);
      return next;
    });
  }, [guideKey]);
  const guideChannels = useMemo(
    () => (filtered.length > guideReveal ? filtered.slice(0, guideReveal) : filtered),
    [filtered, guideReveal],
  );
  const guideHasMore = filtered.length > guideChannels.length;

  // Resolve now/next for the visible cards ONCE per render (not per card) —
  // keyed on the visible set, source, the 30 s now-tick, and the EPG version
  // (so it re-resolves when the EPG finishes loading). `epgVer` participates
  // only as a re-trigger. Bounded to MAX_VISIBLE entries.
  // A result equal to the last one (same programme objects) keeps its old
  // object, so a re-filter or a tick inside the same programme leaves the
  // memoized cards alone (resolveNowNext builds a new object every call).
  const prevNowNext = useRef(new Map<string, NowNext>());
  const nowNextByChannel = useMemo(() => {
    const map = new Map<string, NowNext>();
    if (!selectedSourceId || !epgReady) return map;
    const prev = prevNowNext.current;
    for (const ch of visible) {
      const nn = resolveNowNext(selectedSourceId, ch, nowMs);
      if (!nn || !(nn.now || nn.next)) continue;
      const old = prev.get(ch.id);
      map.set(ch.id, old && old.now === nn.now && old.next === nn.next ? old : nn);
    }
    prevNowNext.current = map;
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, selectedSourceId, nowMs, epgReady, epgVer]);

  // ── Favourites (cross-playlist) ──────────────────────────────────────
  const totalFavorites = useMemo(() => favoriteCount(), [favVer]);
  const favorites = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    const list = [...getFavorites()];
    return q ? list.filter((f) => f.channel.name.toLowerCase().includes(q)) : list;
  }, [favVer, deferredQuery]);
  // Cap the rendered favourites (same MAX_VISIBLE budget as the channel grid
  // — don't mount hundreds of cards) and resolve now/next ONCE per render
  // into a keyed map instead of an inline call per card (which defeated the
  // card memo and re-ran up to 500 EPG scans every 30s tick).
  const visibleFavorites = useMemo(
    () => (favorites.length > MAX_VISIBLE ? favorites.slice(0, MAX_VISIBLE) : favorites),
    [favorites],
  );
  const prevFavNowNext = useRef(new Map<string, NowNext>());
  const favNowNextByKey = useMemo(() => {
    const map = new Map<string, NowNext>();
    const prev = prevFavNowNext.current;
    for (const fav of visibleFavorites) {
      const nn = resolveNowNext(fav.sourceId, fav.channel, nowMs);
      if (!nn || !(nn.now || nn.next)) continue;
      const old = prev.get(fav.key);
      map.set(fav.key, old && old.now === nn.now && old.next === nn.next ? old : nn);
    }
    prevFavNowNext.current = map;
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleFavorites, nowMs, epgVer]);

  /** Play a favourite — its origin playlist may not be the selected one, so
   *  synthesise the minimal playlist handlePlayChannel needs (it only reads
   *  `.name`). */
  const sources = state.sources;
  const playFavorite = useCallback((channel: IptvChannel, sourceId: string, sourceName: string) => {
    onPlayChannel(channel, {
      id: sourceId,
      name: sourceName,
      url: "",
      epgUrl: null,
      channels: [],
      fetchedAt: 0,
      groups: [],
      // Carry the origin source's proxy so a favourite plays through the same
      // proxy as it would from its own playlist.
      proxyUrl: sources.find((s) => s.id === sourceId)?.proxyUrl ?? null,
    });
  }, [sources, onPlayChannel]);
  /** Play a channel of the selected playlist. Stable, so the memoized grid
   *  cards and guide rows are not re-rendered by every page render (a hover,
   *  a keystroke, a tick) through a fresh inline closure. */
  const playFromPlaylist = useCallback((channel: IptvChannel) => {
    if (playlist) onPlayChannel(channel, playlist);
  }, [playlist, onPlayChannel]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-3 flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 data-glass-light="text" className="aura-row-title text-3xl font-semibold tracking-tight">Live TV</h1>
          <p className="text-white/60 text-sm mt-1">
            Your IPTV playlists. Channels stream through the normal player.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {state.sources.length > 0 && (
            <SourcePicker
              sources={state.sources}
              selectedId={selectedSourceId}
              defaultId={state.defaultId}
              onSetDefault={(id) => void setDefaultPlaylist(id)}
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
            className="aura-glass-flat aura-glass-press is-primary px-3.5 h-9 rounded-xl text-[13px] font-medium"
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
            {...sheet("aura-live-rail relative w-56 flex-shrink-0 overflow-y-auto ml-6 mb-4 rounded-[18px] p-1.5")}
            style={{ scrollbarWidth: "thin", scrollbarColor: "rgba(255,255,255,0.08) transparent" }}
            {...groupDroplet.listProps}
          >
            <span ref={groupDroplet.ref} aria-hidden className="aura-glass-hl aura-sheet-hl" />
            <GroupRow
              label="★ Favorites"
              count={totalFavorites}
              active={favoritesView}
              onClick={() => setFavoritesView(true)}
              accent
            />
            <GroupRow
              label="All channels"
              count={playlist?.channels.length ?? 0}
              active={!favoritesView && selectedGroup === "All"}
              onClick={() => {
                setFavoritesView(false);
                setSelectedGroup("All");
              }}
            />
            {groups.map((g) => (
              <GroupRow
                key={g.name}
                label={g.name}
                count={g.count}
                active={!favoritesView && selectedGroup === g.name}
                onClick={() => {
                  setFavoritesView(false);
                  setSelectedGroup(g.name);
                }}
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
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  // Clear first, then give the keys back to the page: useKeybindings
                  // ignores a focused input.
                  if (query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery("");
                  } else {
                    e.currentTarget.blur();
                  }
                }}
                placeholder={favoritesView ? "Search favorites…" : "Search channels…"}
                data-aura-search
                // Glass text field (App.css GLASS SYSTEM): the fill, border and
                // focus edge come from the class in both materials.
                className="aura-glass-field h-9 w-64 max-w-full px-3 rounded-xl
                           text-[13px] text-white/90 placeholder:text-white/30
                           outline-none"
              />
              {favoritesView ? (
                <span className="text-white/55 text-xs">
                  {favorites.length.toLocaleString()} favorite{favorites.length === 1 ? "" : "s"}
                  {favorites.length > MAX_VISIBLE && ` · showing first ${MAX_VISIBLE} (refine to see all)`}
                </span>
              ) : playlist ? (
                <span className="text-white/55 text-xs">
                  {filtered.length.toLocaleString()} channel{filtered.length === 1 ? "" : "s"}
                  {viewMode === "grid" && filtered.length > MAX_VISIBLE &&
                    ` · showing first ${MAX_VISIBLE} (refine to see all)`}
                  {viewMode === "guide" && guideHasMore &&
                    ` · showing ${guideChannels.length.toLocaleString()}, scroll for more`}
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
                  <p className="text-white/60 text-sm py-12 text-center max-w-[28rem] mx-auto">
                    {deferredQuery
                      ? "No favorites match your search."
                      : "No favorites yet. Hover a channel and tap the ★ to add it here. Favorites span every playlist."}
                  </p>
                ) : (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(186px, 1fr))" }}
                  >
                    {visibleFavorites.map((fav) => {
                      const nn = favNowNextByKey.get(fav.key) ?? null;
                      return (
                        <ChannelCard
                          key={fav.key}
                          channel={fav.channel}
                          sourceId={fav.sourceId}
                          sourceName={fav.sourceName}
                          nowNext={nn}
                          // Only a card with a programme on air reads the clock.
                          nowMs={nn?.now ? nowMs : 0}
                          onPlay={playFavorite}
                          favorited
                          sourceLabel={fav.sourceName}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            ) : viewMode === "multiview" ? (
              <MultiView
                channels={filtered}
                suspended={playerActive}
                onPlayChannel={playFromPlaylist}
              />
            ) : viewMode === "guide" ? (
              <GuideView
                channels={guideChannels}
                sourceId={selectedSourceId ?? ""}
                sourceName={playlist?.name ?? selectedSourceId ?? ""}
                nowMs={nowMs}
                hasEpg={epgReady}
                epgLoading={epgLoading}
                epgError={epgErr}
                onRetryEpg={retryEpg}
                truncated={epgIsTruncated}
                hasMore={guideHasMore}
                onReachEnd={revealMoreGuide}
                onPlayChannel={playFromPlaylist}
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
                  <p className="text-white/60 text-sm py-12 text-center">
                    {deferredQuery ? "No channels match your search." : "No channels in this group."}
                  </p>
                ) : (
                  <div
                    className="grid gap-3"
                    style={{ gridTemplateColumns: "repeat(auto-fill, minmax(186px, 1fr))" }}
                  >
                    {visible.map((ch) => {
                      const nn = nowNextByChannel.get(ch.id) ?? null;
                      return (
                        <ChannelCard
                          key={ch.id}
                          channel={ch}
                          sourceId={selectedSourceId}
                          sourceName={playlist?.name ?? selectedSourceId ?? ""}
                          nowNext={nn}
                          // Only a card with a programme on air reads the clock.
                          nowMs={nn?.now ? nowMs : 0}
                          onPlay={playFromPlaylist}
                          favorited={!!selectedSourceId && isFavorite(selectedSourceId, ch.id)}
                        />
                      );
                    })}
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
  sourceId,
  sourceName,
  nowNext,
  nowMs,
  onPlay: onPlayChannel,
  favorited,
  sourceLabel,
}: {
  channel: IptvChannel;
  /** The playlist the channel belongs to. Null leaves the star and the
   *  right-click menu inert (no playlist selected). */
  sourceId: string | null;
  sourceName: string;
  nowNext: NowNext | null;
  /** The clock, read only for the on-air progress bar. */
  nowMs: number;
  /** Stable across renders (the parent's useCallback), so the memo holds:
   *  the card passes its own channel and source back. */
  onPlay: (channel: IptvChannel, sourceId: string, sourceName: string) => void;
  favorited: boolean;
  /** Shown under the name in the favourites view (which playlist it's from). */
  sourceLabel?: string;
}) {
  const onPlay = () => onPlayChannel(channel, sourceId ?? "", sourceName);
  const onToggleFavorite = () => {
    if (sourceId) toggleFavorite(sourceId, sourceName, channel);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    if (sourceId) openChannelMenu(e, { channel, sourceId, sourceName, onPlay });
  };
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
      onContextMenu={onContextMenu}
      title={now ? `${channel.name}: ${now.title}` : channel.name}
      className="aura-content-card is-live aura-live-channel group relative flex flex-col items-stretch text-left
                 rounded-[12px] overflow-hidden cursor-pointer focus:outline-none"
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
              className="block h-full bg-[var(--ln-accent-mark)]"
              style={{ width: `${(progress * 100).toFixed(1)}%` }}
            />
          </span>
        )}
      </div>
      <div className="px-2.5 py-2">
        <p className="text-[12.5px] text-white/85 font-medium truncate">{channel.name}</p>
        {now ? (
          <p className="text-[10.5px] text-[color:var(--ln-accent-mark-text)] truncate" title={now.title}>
            {now.title}
          </p>
        ) : (
          <p className="text-[10.5px] text-white/55 truncate">{sourceLabel ?? channel.group}</p>
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
  // The shared glass segmented control (one sliding indicator).
  return (
    <SegmentedControl<ViewMode>
      value={mode}
      onChange={onChange}
      ariaLabel="Live TV view"
      className="ml-auto"
      options={[
        { value: "grid", label: "Grid" },
        { value: "guide", label: "Guide" },
        { value: "multiview", label: "Multiview" },
      ]}
    />
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
      aria-current={active ? "true" : undefined}
      data-glass-light={active ? "rim" : undefined}
      className={[
        "aura-sheet-row w-full flex items-center justify-between gap-2 px-3 h-9 text-left",
        accent ? "is-fav" : "",
        active
          ? "is-selected"
          : accent
            ? "text-amber-200/85 hover:text-amber-200"
            : "text-white/65 hover:text-white/90",
      ].join(" ")}
    >
      <span className="text-[12.5px] font-medium truncate">{label}</span>
      <span className="text-[10.5px] text-white/50 tabular-nums flex-shrink-0">{count}</span>
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
  defaultId,
  onSetDefault,
  onSelect,
  onRefresh,
  onEdit,
  onRemove,
}: {
  sources: { id: string; name: string }[];
  selectedId: string | null;
  defaultId: string | null;
  onSetDefault: (id: string) => void;
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
        aria-expanded={open}
        className="aura-glass-flat aura-pill-dd px-3.5 h-9 rounded-xl text-[13px] font-medium
                   text-white/85 flex items-center gap-2 max-w-[240px]"
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
            // Floating glass (menu tier) growing from its trigger's corner.
            className="aura-float-glass aura-glass-pop-in absolute right-0 mt-1 w-[280px] max-h-[60vh]
                       overflow-y-auto z-40 rounded-xl py-1"
            style={{ "--lg-origin": "top right" } as React.CSSProperties}
          >
            {sources.map((s) => (
              <div
                key={s.id}
                aria-current={s.id === selectedId ? "true" : undefined}
                className="aura-glass-row flex items-center gap-1 px-2 py-1.5 mx-1 rounded-lg group"
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
                  title={s.id === defaultId ? "Default playlist (click to unset)" : "Set as default"}
                  onClick={() => onSetDefault(s.id)}
                  className={[
                    "w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 transition-colors",
                    s.id === defaultId
                      ? "text-ln-accent hover:bg-white/10"
                      : "text-white/40 hover:text-white/90 hover:bg-white/10",
                  ].join(" ")}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24"
                       fill={s.id === defaultId ? "currentColor" : "none"}
                       stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    {/* pin */}
                    <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3-1-5z" />
                    <path d="M12 16v4" />
                  </svg>
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
        <p className="text-white/60 text-sm mt-1 max-w-[24rem]">
          Add an M3U playlist or Xtream login to browse and watch live channels.
        </p>
      </div>
      {loaded && (
        <button
          type="button"
          onClick={onAdd}
          className="aura-glass-flat aura-glass-press is-primary mt-1 px-4 h-9 rounded-xl text-[13px] font-medium"
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
      <p className="text-red-300/90 text-sm max-w-[28rem]">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="aura-glass-flat aura-glass-press px-3.5 h-9 rounded-xl text-[13px] font-medium text-white/80"
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
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(186px, 1fr))" }}
    >
      {Array.from({ length: 18 }).map((_, i) => (
        <div key={i} className="rounded-[12px] overflow-hidden bg-white/[0.03]">
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
