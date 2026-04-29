export interface AddonEntry {
  url: string;
  name: string;
  has_search: boolean;
}

export interface MetaPreview {
  id: string;
  name: string;
  media_type: string;
  /** Portrait poster — primary card art. */
  poster: string | null;
  /** Landscape art (Stremio canonical "background"). */
  background: string | null;
  /** Community/AIOMetadata "fanart" field — landscape hero art. */
  fanart: string | null;
  /** Community/AIOMetadata "backdrop" field — alt landscape art. */
  backdrop: string | null;
  logo: string | null;
  release_info: string | null;
  description: string | null;
  imdb_rating: string | null;
}

export interface MetaDetail {
  id: string;
  name: string;
  media_type: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  description: string | null;
  release_info: string | null;
  released: string | null;
  runtime: string | null;
  imdb_rating: string | null;
}

export interface LibraryState {
  /** Time offset of last playback in seconds. */
  timeOffset?: number;
  /** Optional resolved video / episode id. */
  video_id?: string;
  /** MPV duration captured at the time of save. */
  duration?: number;
  [k: string]: unknown;
}

export interface LibraryItem {
  id: string;
  media_type: string;
  name: string;
  poster: string | null;
  background: string | null;
  logo: string | null;
  year: string | null;
  removed: boolean;
  temp: boolean;
  ctime: string | null;
  mtime: string | null;
  state: LibraryState;
}

export type ThemeId = "mica" | "glass" | "midnight";

export interface AppSettings {
  theme: ThemeId;
}
