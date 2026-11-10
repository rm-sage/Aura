// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Movie Digital / Theatrical release dates, for the user's region.
//!
//! Why not MDBList alone: its dates carry no country and proved wrong. For
//! Nolan's The Odyssey (tt33764258) it said `released_digital` 2026-11-07 while
//! Universal and TMDB both said 2026-11-17 (US) and 2026-11-18 (BR, IL, PH), so
//! Aura treated the film as already digital and showed neither a countdown nor
//! "In Theaters".
//!
//! TMDB's `/movie/{id}/release_dates` lists dates PER COUNTRY and PER TYPE
//! (1 premiere, 2 theatrical limited, 3 theatrical, 4 digital, 5 physical,
//! 6 TV). `select_release_dates` picks, for each of digital and theatrical:
//! the user's region, else US, else the earliest anywhere, else MDBList, else
//! nothing (the frontend estimates). Premieres never count as theatrical and
//! physical never counts as digital. A re-release row (TMDB marks those only in
//! its `note`) and any row more than two years after the first of its kind
//! anywhere are ignored, so a 1993 film's 2026 anniversary run is not its date.
//! When the theatrical date is the user's own country's and the digital date
//! had to come from another country, a digital date BEFORE that local run is
//! dropped (Japan routinely opens films months after the US goes digital; the
//! US date would otherwise end the local "In Theaters" before it begins), and
//! the frontend estimates from the local date instead.
//!
//! The region is the Windows "Country or region" setting, read per call (one
//! cheap kernel32 call). The frontend caches an answer for up to six hours, so
//! a region change shows within that time, or at once for movies not yet seen.
//!
//! `tmdb` in the reply says how the TMDB half went ("ok", "none" = TMDB has no
//! such film, "failed", "nokey"), so the frontend can tell "TMDB lists no date"
//! from "TMDB could not be asked" and keep a failed answer only briefly: an
//! MDBList-only answer cached for the session after one TMDB blip would bring
//! back the very date this module exists to replace.
//!
//! Key: `arcs::tmdb_key()` (keyring override, else the baked `AURA_TMDB_KEY`).
//! No key = MDBList only. Every failure degrades to the next fallback and the
//! command never errors.
//!
//! Devlog label: `[release-dates]`.

use serde::{Deserialize, Serialize};

/// TMDB release types.
const TYPE_THEATRICAL_LIMITED: u8 = 2;
const TYPE_THEATRICAL: u8 = 3;
const TYPE_DIGITAL: u8 = 4;

const FALLBACK_REGION: &str = "US";

/// A row this many days after the first row of its kind anywhere is a later
/// event (a re-release, a remaster), not the film's release.
const LATER_EVENT_DAYS: i64 = 730;

/// A row more than this many days BEFORE the anchor is not the release
/// either: an un-noted or abbreviated festival screening ("TIFF",
/// "Sundance") or an early limited run, which TMDB files as type 2. A real
/// limited opening ahead of the wide one (an awards-qualifying December run)
/// is weeks ahead, not seasons.
const EARLIER_EVENT_DAYS: i64 = 180;

/// The whole TMDB half (find + release_dates, each with tmdb_get's retries) may
/// take this long before the command answers from MDBList alone. tmdb_get can
/// otherwise spend about 50 s per call against a host that drops connections.
const TMDB_DEADLINE: std::time::Duration = std::time::Duration::from_secs(8);

// ---------------------------------------------------------------------------
// The user's region
// ---------------------------------------------------------------------------

/// Accept only an ISO 3166-1 alpha-2 shape (two ASCII letters), uppercased.
/// A Windows geo lookup or a locale tag can carry a UN M.49 numeric code
/// ("001" = World, "419" = Latin America) where there is no alpha-2 code; that
/// is rejected here.
fn alpha2(s: &str) -> Option<String> {
    let t = s.trim();
    if t.len() == 2 && t.bytes().all(|b| b.is_ascii_alphabetic()) {
        Some(t.to_ascii_uppercase())
    } else {
        None
    }
}

/// The country part of a BCP 47 locale name: "en-GB" -> "GB",
/// "zh-Hans-CN" -> "CN", "de-DE_phoneb" -> "DE". A bare language ("en") has
/// no country, so only segments AFTER the first are considered.
fn locale_country(locale: &str) -> Option<String> {
    let base = locale.split('_').next().unwrap_or("");
    base.split('-').skip(1).find_map(alpha2)
}

/// UTF-16 buffer filled by a Win32 `...Name` call -> String. `n` is the call's
/// return value, which counts the terminating NUL; 0 is failure.
#[cfg(windows)]
fn wide_result(buf: &[u16], n: i32) -> Option<String> {
    if n <= 1 {
        return None;
    }
    let len = ((n - 1) as usize).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..len]))
}

/// The user's region as ISO 3166-1 alpha-2. Windows: the "Country or region"
/// setting (`GetUserGeoID` + `GetGeoInfoW(GEO_ISO2)`), else the country of the
/// user's locale (`GetUserDefaultLocaleName`), else "US". Elsewhere: "US".
///
/// NOT `GetUserDefaultGeoName`, which reads the same setting: it exists only
/// from Windows 10 1709, and the windows crate binds it as a LOAD-TIME import,
/// so on an older Windows 10 build (LTSB 2016, 1607) aura.exe would not start
/// at all. The two calls used here go back to Windows XP / Vista.
#[cfg(windows)]
pub fn user_region() -> String {
    use windows::Win32::Globalization::{
        GetGeoInfoW, GetUserDefaultLocaleName, GetUserGeoID, GEOCLASS_NATION, GEOID_NOT_AVAILABLE, GEO_ISO2,
    };

    // SAFETY: no pointers; returns a GEOID or GEOID_NOT_AVAILABLE.
    let geo_id = unsafe { GetUserGeoID(GEOCLASS_NATION) };
    if geo_id != GEOID_NOT_AVAILABLE {
        let mut iso = [0u16; 8];
        // SAFETY: the slice is a valid, writable buffer; the call writes at
        // most its length and returns the count written (with the NUL) or 0.
        let n = unsafe { GetGeoInfoW(geo_id, GEO_ISO2, Some(&mut iso), 0) };
        // "XX" is Windows' answer for a region that is no country (World,
        // Caribbean, Latin America): fall through to the locale's country.
        if let Some(code) = wide_result(&iso, n).as_deref().and_then(alpha2).filter(|c| c != "XX") {
            return code;
        }
    }

    // LOCALE_NAME_MAX_LENGTH is 85.
    let mut loc = [0u16; 85];
    // SAFETY: as above.
    let n = unsafe { GetUserDefaultLocaleName(&mut loc) };
    if let Some(code) = wide_result(&loc, n).as_deref().and_then(locale_country) {
        return code;
    }

    FALLBACK_REGION.to_string()
}

#[cfg(not(windows))]
pub fn user_region() -> String {
    FALLBACK_REGION.to_string()
}

// ---------------------------------------------------------------------------
// Selection (pure)
// ---------------------------------------------------------------------------

/// One flattened row of TMDB's release_dates payload.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReleaseRow {
    /// ISO 3166-1 alpha-2, uppercase.
    pub country: String,
    /// TMDB release type (1..=6).
    pub kind: u8,
    /// `YYYY-MM-DD`.
    pub date: String,
    /// TMDB's free-text note, lowercased ("re-release", "imax", ...).
    pub note: String,
}

/// Movie release dates returned to the frontend. Field names are the wire
/// names (Tauri serialises Rust names as-is) and match `src/releaseDates.ts`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct MovieReleaseDates {
    /// `YYYY-MM-DD`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theatrical: Option<String>,
    /// "tmdb" | "mdblist".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theatrical_source: Option<String>,
    /// Alpha-2 of the TMDB row used (source "tmdb" only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theatrical_region: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digital: Option<String>,
    /// "tmdb" | "mdblist".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digital_source: Option<String>,
    /// Alpha-2 of the TMDB row used (source "tmdb" only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digital_region: Option<String>,
    /// The region Aura asked for (alpha-2).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    /// How the TMDB half went: "ok" | "none" | "failed" | "nokey". Set by the
    /// fetch, not by the pure selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tmdb: Option<String>,
}

/// Days since 1970-01-01 for a `YYYY-MM-DD` date (Howard Hinnant's
/// days_from_civil), or None for anything else.
fn day_number(date: &str) -> Option<i64> {
    let y: i64 = date.get(0..4)?.parse().ok()?;
    let m: i64 = date.get(5..7)?.parse().ok()?;
    let d: i64 = date.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

/// A note that marks a later event rather than the film's own release.
fn is_later_event_note(note: &str) -> bool {
    ["re-release", "rerelease", "re release", "anniversary", "reissue", "re-issue", "remaster", "restoration"]
        .iter()
        .any(|k| note.contains(k))
}

/// A festival screening, not a release (TMDB files many as type 2, limited).
/// Notes are lower-cased; the named festivals are the ones TMDB notes most
/// often by name alone.
fn is_festival_note(note: &str) -> bool {
    note.contains("festival")
        || note.contains("film fest")
        || ["sundance", "tiff", "cannes", "berlinale", "sxsw", "telluride", "venice", "tribeca", "fantastic fest"]
            .iter()
            .any(|k| note.contains(k))
}

/// The rows of `kinds` that are the film's own release: no re-release or
/// festival note, not more than LATER_EVENT_DAYS after the ANCHOR and not
/// more than EARLIER_EVENT_DAYS before it.
///
/// The anchor is the earliest row of the FIRST kind in `kinds` that has any
/// (callers list the wide kind first: theatrical before limited), not the
/// earliest row of any kind: an early limited or awards-qualifying run, or a
/// festival screening years before the wide release, would otherwise put the
/// real release past the cut and leave the festival date as "the" release.
fn release_rows<'a>(rows: &'a [ReleaseRow], kinds: &[u8]) -> Vec<&'a ReleaseRow> {
    let own: Vec<&ReleaseRow> = rows
        .iter()
        .filter(|r| kinds.contains(&r.kind) && !is_later_event_note(&r.note) && !is_festival_note(&r.note))
        .collect();
    let first = kinds
        .iter()
        .find_map(|k| own.iter().filter(|r| r.kind == *k).filter_map(|r| day_number(&r.date)).min());
    match first {
        Some(first) => own
            .into_iter()
            .filter(|r| {
                day_number(&r.date).map_or(false, |d| (-EARLIER_EVENT_DAYS..=LATER_EVENT_DAYS).contains(&(d - first)))
            })
            .collect(),
        None => Vec::new(),
    }
}

/// The earliest of `rows`, limited to `country` when given. Ties on the date
/// break alphabetically by country, so the answer is deterministic whatever
/// order TMDB lists the countries in.
fn earliest<'a>(rows: &[&'a ReleaseRow], country: Option<&str>) -> Option<&'a ReleaseRow> {
    rows.iter()
        .copied()
        .filter(|r| country.map_or(true, |c| r.country == c))
        .min_by(|a, b| a.date.cmp(&b.date).then_with(|| a.country.cmp(&b.country)))
}

/// Region, else US (when the region is not US), else earliest anywhere.
fn pick<'a>(rows: &'a [ReleaseRow], kinds: &[u8], region: &str) -> Option<&'a ReleaseRow> {
    let own = release_rows(rows, kinds);
    earliest(&own, Some(region))
        .or_else(|| {
            if region != FALLBACK_REGION {
                earliest(&own, Some(FALLBACK_REGION))
            } else {
                None
            }
        })
        .or_else(|| earliest(&own, None))
}

/// Choose the digital and theatrical dates from TMDB's rows for `region`,
/// falling back to MDBList's `released` / `released_digital`. Pure: no I/O.
pub fn select_release_dates(
    rows: &[ReleaseRow],
    region: &str,
    mdb_theatrical: Option<String>,
    mdb_digital: Option<String>,
) -> MovieReleaseDates {
    let mut out = MovieReleaseDates {
        region: Some(region.to_string()),
        ..Default::default()
    };

    if let Some(r) = pick(rows, &[TYPE_DIGITAL], region) {
        out.digital = Some(r.date.clone());
        out.digital_source = Some("tmdb".into());
        out.digital_region = Some(r.country.clone());
    } else if let Some(d) = mdb_digital {
        out.digital = Some(d);
        out.digital_source = Some("mdblist".into());
    }

    if let Some(r) = pick(rows, &[TYPE_THEATRICAL, TYPE_THEATRICAL_LIMITED], region) {
        out.theatrical = Some(r.date.clone());
        out.theatrical_source = Some("tmdb".into());
        out.theatrical_region = Some(r.country.clone());
    } else if let Some(d) = mdb_theatrical {
        out.theatrical = Some(d);
        out.theatrical_source = Some("mdblist".into());
    }

    // The user's own theatrical run outranks another country's earlier digital
    // date (see the module comment). Dropped rather than replaced with MDBList,
    // which has no country either; the frontend then estimates from the local
    // run and says so.
    let local_theatrical = out.theatrical_source.as_deref() == Some("tmdb")
        && out.theatrical_region.as_deref() == Some(region);
    let foreign_digital = out.digital.is_some() && out.digital_region.as_deref() != Some(region);
    if local_theatrical && foreign_digital {
        if let (Some(t), Some(d)) = (out.theatrical.as_deref().and_then(day_number), out.digital.as_deref().and_then(day_number)) {
            if d < t {
                out.digital = None;
                out.digital_source = None;
                out.digital_region = None;
            }
        }
    }

    out
}

// ---------------------------------------------------------------------------
// TMDB payloads
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct FindMovie {
    id: Option<u64>,
}

#[derive(Deserialize)]
struct FindResult {
    #[serde(default)]
    movie_results: Vec<FindMovie>,
}

#[derive(Deserialize)]
struct TmdbDate {
    #[serde(default)]
    release_date: Option<String>,
    #[serde(rename = "type", default)]
    kind: Option<u8>,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Deserialize)]
struct TmdbCountry {
    #[serde(default)]
    iso_3166_1: Option<String>,
    #[serde(default)]
    release_dates: Vec<TmdbDate>,
}

#[derive(Deserialize)]
struct TmdbReleaseDates {
    #[serde(default)]
    results: Vec<TmdbCountry>,
}

/// `YYYY-MM-DD` prefix of a TMDB timestamp ("2026-11-17T00:00:00.000Z"), only
/// when it really has that shape.
fn date_prefix(s: &str) -> Option<String> {
    let d = s.trim().get(..10)?;
    let b = d.as_bytes();
    let ok = b.iter().enumerate().all(|(i, c)| match i {
        4 | 7 => *c == b'-',
        _ => c.is_ascii_digit(),
    });
    ok.then(|| d.to_string())
}

/// Flatten TMDB's release_dates payload into rows, dropping anything without a
/// valid country, type or date.
fn parse_rows(body: &str) -> Option<Vec<ReleaseRow>> {
    let parsed: TmdbReleaseDates = serde_json::from_str(body).ok()?;
    let mut rows = Vec::new();
    for c in parsed.results {
        let Some(country) = c.iso_3166_1.as_deref().and_then(alpha2) else { continue };
        for d in c.release_dates {
            let (Some(kind), Some(date)) = (d.kind, d.release_date.as_deref().and_then(date_prefix)) else {
                continue;
            };
            let note = d.note.as_deref().unwrap_or("").trim().to_lowercase();
            rows.push(ReleaseRow { country: country.clone(), kind, date, note });
        }
    }
    Some(rows)
}

/// What the TMDB half produced, for the log line.
enum TmdbOutcome {
    NoKey,
    NoMatch,
    Failed(&'static str),
    Rows(Vec<ReleaseRow>),
}

/// The TMDB movie id by `/find` on the IMDb id, then its release_dates rows.
/// Never errors; the outcome says why there are no rows. The addon meta's own
/// `tmdb_id` is deliberately not used: wherever the repo fills it, it can be a
/// SERIES id (src/externalSources.ts), and TMDB numbers films and TV apart, so
/// `/movie/{that id}` can answer an unrelated film's dates, labelled Confirmed.
async fn tmdb_rows(imdb_id: &str) -> TmdbOutcome {
    let Some(key) = crate::arcs::tmdb_key() else { return TmdbOutcome::NoKey };
    if !imdb_id.starts_with("tt") {
        return TmdbOutcome::NoMatch;
    }
    // `tmdb_get`'s error text can carry the URL (and so the key) from
    // reqwest's Display: it is dropped, never logged.
    let Ok(body) = crate::arcs::tmdb_get(&format!("/find/{imdb_id}?external_source=imdb_id"), &key).await else {
        return TmdbOutcome::Failed("find");
    };
    let Ok(found) = serde_json::from_str::<FindResult>(&body) else {
        return TmdbOutcome::Failed("find parse");
    };
    let Some(id) = found.movie_results.first().and_then(|m| m.id) else {
        return TmdbOutcome::NoMatch;
    };

    let Ok(body) = crate::arcs::tmdb_get(&format!("/movie/{id}/release_dates"), &key).await else {
        return TmdbOutcome::Failed("release_dates");
    };
    match parse_rows(&body) {
        Some(rows) => TmdbOutcome::Rows(rows),
        None => TmdbOutcome::Failed("release_dates parse"),
    }
}

/// The whole fetch, separate from the command so the network test can call it.
async fn fetch(imdb_id: &str) -> MovieReleaseDates {
    let region = user_region();

    let tmdb = async {
        tokio::time::timeout(TMDB_DEADLINE, tmdb_rows(imdb_id))
            .await
            .unwrap_or(TmdbOutcome::Failed("deadline"))
    };
    let ((mdb_theatrical, mdb_digital), tmdb) =
        tokio::join!(crate::ratings::mdblist_release_dates(imdb_id), tmdb);

    let (rows, tmdb_note, status) = match tmdb {
        TmdbOutcome::Rows(rows) => {
            let note = format!("{} rows", rows.len());
            (rows, note, "ok")
        }
        TmdbOutcome::NoKey => (Vec::new(), "no key".to_string(), "nokey"),
        TmdbOutcome::NoMatch => (Vec::new(), "no match".to_string(), "none"),
        TmdbOutcome::Failed(step) => (Vec::new(), format!("{step} failed"), "failed"),
    };

    let mut out = select_release_dates(&rows, &region, mdb_theatrical, mdb_digital);
    out.tmdb = Some(status.to_string());

    let describe = |date: &Option<String>, source: &Option<String>, reg: &Option<String>| match (date, source) {
        (Some(d), Some(s)) => match reg {
            Some(r) => format!("{d} ({s} {r})"),
            None => format!("{d} ({s})"),
        },
        _ => "none".to_string(),
    };
    crate::devlog!(
        info, "release-dates",
        "{imdb_id} region {region}: digital {}, theatrical {} [tmdb: {tmdb_note}]",
        describe(&out.digital, &out.digital_source, &out.digital_region),
        describe(&out.theatrical, &out.theatrical_source, &out.theatrical_region),
    );

    out
}

/// Digital + Theatrical release dates for a movie by IMDb id, picked for the
/// user's region. Never errors: an unavailable date is simply absent.
#[tauri::command]
pub async fn fetch_movie_release_dates(imdb_id: String) -> Result<MovieReleaseDates, String> {
    if !imdb_id.starts_with("tt") {
        return Ok(MovieReleaseDates {
            region: Some(user_region()),
            tmdb: Some("none".into()),
            ..Default::default()
        });
    }
    Ok(fetch(&imdb_id).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(country: &str, kind: u8, date: &str) -> ReleaseRow {
        ReleaseRow { country: country.into(), kind, date: date.into(), note: String::new() }
    }

    fn noted(country: &str, kind: u8, date: &str, note: &str) -> ReleaseRow {
        ReleaseRow { country: country.into(), kind, date: date.into(), note: note.into() }
    }

    /// Shaped like The Odyssey's real TMDB data (2026-11-08).
    fn odyssey() -> Vec<ReleaseRow> {
        vec![
            row("BE", 3, "2026-07-15"),
            row("BH", 3, "2026-07-15"),
            row("CH", 3, "2026-07-15"),
            row("US", 3, "2026-07-17"),
            row("US", 4, "2026-11-17"),
            row("US", 5, "2026-11-17"),
            row("BR", 4, "2026-11-18"),
            row("IL", 4, "2026-11-18"),
            row("PH", 4, "2026-11-18"),
        ]
    }

    fn mdb_odyssey() -> (Option<String>, Option<String>) {
        (Some("2026-07-17".into()), Some("2026-11-07".into()))
    }

    #[test]
    fn odyssey_region_us() {
        let (t, d) = mdb_odyssey();
        let out = select_release_dates(&odyssey(), "US", t, d);
        assert_eq!(out.digital.as_deref(), Some("2026-11-17"));
        assert_eq!(out.digital_source.as_deref(), Some("tmdb"));
        assert_eq!(out.digital_region.as_deref(), Some("US"));
        assert_eq!(out.theatrical.as_deref(), Some("2026-07-17"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
        assert_eq!(out.region.as_deref(), Some("US"));
    }

    #[test]
    fn odyssey_region_br() {
        let (t, d) = mdb_odyssey();
        let out = select_release_dates(&odyssey(), "BR", t, d);
        assert_eq!(out.digital.as_deref(), Some("2026-11-18"));
        assert_eq!(out.digital_source.as_deref(), Some("tmdb"));
        assert_eq!(out.digital_region.as_deref(), Some("BR"));
        // BR has no theatrical row in the fixture: US.
        assert_eq!(out.theatrical.as_deref(), Some("2026-07-17"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
    }

    #[test]
    fn odyssey_region_gb_falls_to_us() {
        let (t, d) = mdb_odyssey();
        let out = select_release_dates(&odyssey(), "GB", t, d);
        assert_eq!(out.digital.as_deref(), Some("2026-11-17"));
        assert_eq!(out.digital_source.as_deref(), Some("tmdb"));
        assert_eq!(out.digital_region.as_deref(), Some("US"));
        assert_eq!(out.theatrical.as_deref(), Some("2026-07-17"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
        assert_eq!(out.region.as_deref(), Some("GB"));
    }

    #[test]
    fn region_hit() {
        let rows = vec![row("US", 4, "2026-01-10"), row("DE", 4, "2026-02-01"), row("DE", 3, "2025-10-01")];
        let out = select_release_dates(&rows, "DE", None, None);
        assert_eq!(out.digital.as_deref(), Some("2026-02-01"));
        assert_eq!(out.digital_region.as_deref(), Some("DE"));
        assert_eq!(out.theatrical.as_deref(), Some("2025-10-01"));
        assert_eq!(out.theatrical_region.as_deref(), Some("DE"));
    }

    #[test]
    fn region_hit_takes_earliest_of_its_rows() {
        let rows = vec![row("DE", 4, "2026-03-01"), row("DE", 4, "2026-02-01")];
        let out = select_release_dates(&rows, "DE", None, None);
        assert_eq!(out.digital.as_deref(), Some("2026-02-01"));
    }

    #[test]
    fn region_miss_falls_to_us() {
        let rows = vec![row("FR", 4, "2026-01-01"), row("US", 4, "2026-01-10"), row("US", 2, "2025-09-01")];
        let out = select_release_dates(&rows, "JP", None, None);
        assert_eq!(out.digital.as_deref(), Some("2026-01-10"));
        assert_eq!(out.digital_region.as_deref(), Some("US"));
        assert_eq!(out.theatrical.as_deref(), Some("2025-09-01"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
    }

    #[test]
    fn us_miss_falls_to_earliest_anywhere() {
        let rows = vec![row("FR", 4, "2026-01-05"), row("DE", 4, "2026-01-01"), row("AT", 4, "2026-01-01")];
        let out = select_release_dates(&rows, "JP", None, None);
        // Tie on the date breaks alphabetically: AT before DE.
        assert_eq!(out.digital.as_deref(), Some("2026-01-01"));
        assert_eq!(out.digital_region.as_deref(), Some("AT"));
        // Region US itself, no US rows: same rule.
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.digital_region.as_deref(), Some("AT"));
    }

    #[test]
    fn physical_only_never_counts_as_digital() {
        let rows = vec![row("US", 5, "2026-01-01")];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.digital, None);
        assert_eq!(out.digital_source, None);
        let out = select_release_dates(&rows, "US", None, Some("2026-02-02".into()));
        assert_eq!(out.digital.as_deref(), Some("2026-02-02"));
        assert_eq!(out.digital_source.as_deref(), Some("mdblist"));
        assert_eq!(out.digital_region, None);
    }

    #[test]
    fn premiere_only_never_counts_as_theatrical() {
        let rows = vec![row("US", 1, "2025-12-01"), row("US", 6, "2026-05-01")];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.theatrical, None);
        assert_eq!(out.theatrical_source, None);
        assert_eq!(out.digital, None);
    }

    #[test]
    fn mdblist_fallback_when_tmdb_has_nothing() {
        let out = select_release_dates(&[], "US", Some("2025-07-01".into()), Some("2025-09-01".into()));
        assert_eq!(out.theatrical.as_deref(), Some("2025-07-01"));
        assert_eq!(out.theatrical_source.as_deref(), Some("mdblist"));
        assert_eq!(out.theatrical_region, None);
        assert_eq!(out.digital.as_deref(), Some("2025-09-01"));
        assert_eq!(out.digital_source.as_deref(), Some("mdblist"));
        assert_eq!(out.digital_region, None);
        let none = select_release_dates(&[], "US", None, None);
        assert_eq!(none, MovieReleaseDates { region: Some("US".into()), ..Default::default() });
    }

    #[test]
    fn rerelease_note_is_not_the_release() {
        // A 1993 film with only a German anniversary run listed for Germany.
        let rows = vec![row("US", 3, "1993-06-11"), noted("DE", 3, "2026-12-03", "re-release")];
        let out = select_release_dates(&rows, "DE", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("1993-06-11"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
    }

    #[test]
    fn unlabelled_later_event_is_not_the_release() {
        // Same, with no note at all: more than two years after the first run.
        let rows = vec![row("US", 3, "1993-06-11"), row("DE", 3, "2026-12-03"), row("DE", 4, "2027-01-10"), row("US", 4, "1997-03-01")];
        let out = select_release_dates(&rows, "DE", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("1993-06-11"));
        assert_eq!(out.digital.as_deref(), Some("1997-03-01"));
        assert_eq!(out.digital_region.as_deref(), Some("US"));
        // A late but real local run (inside two years) still counts.
        let rows = vec![row("US", 3, "2026-07-17"), row("JP", 3, "2027-03-01")];
        let out = select_release_dates(&rows, "JP", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2027-03-01"));
        assert_eq!(out.theatrical_region.as_deref(), Some("JP"));
    }

    #[test]
    fn festival_or_early_limited_row_does_not_push_out_the_release() {
        // A Cannes screening three years before the US opening.
        let rows = vec![
            noted("FR", 2, "2023-05-20", "cannes film festival"),
            row("US", 3, "2026-12-18"),
            row("US", 4, "2027-03-02"),
        ];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-12-18"));
        assert_eq!(out.theatrical_region.as_deref(), Some("US"));
        // An un-noted early limited run anywhere: the wide row anchors the cut.
        let rows = vec![row("CA", 2, "2023-09-01"), row("US", 3, "2026-01-16")];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-01-16"));
        // ...in the region that has only that early row too, and anywhere.
        let out = select_release_dates(&rows, "CA", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-01-16"));
        let rows = vec![row("CA", 2, "2023-09-01"), row("GB", 3, "2026-01-16")];
        let out = select_release_dates(&rows, "DE", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-01-16"));
        // A festival named without the word "festival".
        let rows = vec![noted("US", 2, "2026-01-25", "sundance"), row("US", 3, "2026-08-14")];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-08-14"));
        // A limited run weeks ahead of the wide one is still the release.
        let rows = vec![row("US", 2, "2025-12-19"), row("US", 3, "2026-01-16")];
        let out = select_release_dates(&rows, "US", None, None);
        assert_eq!(out.theatrical.as_deref(), Some("2025-12-19"));
        // Only a festival row exists: no theatrical date from TMDB (MDBList then).
        let rows = vec![noted("IT", 2, "2026-09-01", "venice film festival")];
        let out = select_release_dates(&rows, "US", Some("2026-10-10".into()), None);
        assert_eq!(out.theatrical.as_deref(), Some("2026-10-10"));
        assert_eq!(out.theatrical_source.as_deref(), Some("mdblist"));
    }

    #[test]
    fn foreign_digital_before_local_run_is_dropped() {
        // Japan opens after the US is already digital.
        let rows = vec![row("US", 3, "2023-07-21"), row("US", 4, "2023-11-21"), row("JP", 3, "2024-03-29")];
        let out = select_release_dates(&rows, "JP", Some("2023-07-21".into()), Some("2023-11-21".into()));
        assert_eq!(out.theatrical.as_deref(), Some("2024-03-29"));
        assert_eq!(out.theatrical_region.as_deref(), Some("JP"));
        assert_eq!(out.digital, None, "a US digital date before the Japanese run must not end it");
        assert_eq!(out.digital_source, None);
        // A foreign digital date AFTER the local run is kept.
        let rows = vec![row("US", 3, "2026-07-17"), row("US", 4, "2026-11-17"), row("JP", 3, "2026-08-01")];
        let out = select_release_dates(&rows, "JP", None, None);
        assert_eq!(out.digital.as_deref(), Some("2026-11-17"));
        assert_eq!(out.digital_region.as_deref(), Some("US"));
        // Theatrical from another country: the rule does not apply.
        let rows = vec![row("US", 3, "2026-07-17"), row("US", 4, "2026-11-17")];
        let out = select_release_dates(&rows, "JP", None, None);
        assert_eq!(out.digital.as_deref(), Some("2026-11-17"));
    }

    #[test]
    fn day_numbers() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-11-17").unwrap() - day_number("2026-07-17").unwrap(), 123);
        assert_eq!(day_number("2024-03-01").unwrap() - day_number("2024-02-28").unwrap(), 2);
        assert_eq!(day_number("bogus"), None);
        assert_eq!(day_number("2026-13-01"), None);
    }

    #[test]
    fn region_codes() {
        assert_eq!(alpha2("US").as_deref(), Some("US"));
        assert_eq!(alpha2("gb").as_deref(), Some("GB"));
        assert_eq!(alpha2("001"), None);
        assert_eq!(alpha2("USA"), None);
        assert_eq!(locale_country("en-GB").as_deref(), Some("GB"));
        assert_eq!(locale_country("zh-Hans-CN").as_deref(), Some("CN"));
        assert_eq!(locale_country("de-DE_phoneb").as_deref(), Some("DE"));
        assert_eq!(locale_country("en"), None);
        assert_eq!(locale_country("es-419"), None);
    }

    #[test]
    fn parses_tmdb_payload() {
        let body = r#"{"id":1,"results":[
            {"iso_3166_1":"US","release_dates":[
                {"certification":"","release_date":"2026-11-17T00:00:00.000Z","type":4,"note":" "},
                {"certification":"","release_date":"bogus","type":3}
            ]},
            {"iso_3166_1":"001","release_dates":[{"release_date":"2026-01-01T00:00:00.000Z","type":4}]}
        ]}"#;
        let rows = parse_rows(body).unwrap();
        assert_eq!(rows, vec![row("US", 4, "2026-11-17")]);
    }

    #[test]
    fn serialises_contract_names() {
        let out = select_release_dates(&odyssey(), "US", None, None);
        let v = serde_json::to_value(&out).unwrap();
        let obj = v.as_object().unwrap();
        let mut keys: Vec<&str> = obj.keys().map(|k| k.as_str()).collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["digital", "digital_region", "digital_source", "region", "theatrical", "theatrical_region", "theatrical_source"]
        );
    }

    /// Real network: needs the baked keys (build.rs reads `.env.local`).
    /// `cargo test release_dates_network -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn release_dates_network() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        println!("user_region() = {}", user_region());
        for id in ["tt33764258", "tt41605854"] {
            let out = rt.block_on(fetch(id));
            println!("{id}: {}", serde_json::to_string(&out).unwrap());
        }
    }
}
