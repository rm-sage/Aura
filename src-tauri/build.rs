use std::collections::HashMap;

/// Parse a dotenv-style file into a key->value map. `KEY=VALUE` lines;
/// `#` comments and blank lines skipped; surrounding quotes/space
/// trimmed. Splits on the FIRST `=` so values may themselves contain
/// `=` (base64 keys, etc.).
fn parse_dotenv(path: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(path) {
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                let k = k.trim().to_string();
                let v = v.trim().trim_matches('"').trim_matches('\'').trim().to_string();
                if !k.is_empty() {
                    map.insert(k, v);
                }
            }
        }
    }
    map
}

/// Resolve a build-time secret: a real environment variable of the same
/// name wins (CI), else the `.env.local` value, else empty. An empty
/// string bakes cleanly and the consuming feature no-ops.
fn resolve_secret(env_file: &HashMap<String, String>, name: &str) -> String {
    std::env::var(name)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| env_file.get(name).cloned())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn main() {
    // Bake app-owned API keys into the binary at BUILD time without them
    // ever entering the repo. Source: a real env var of the same name
    // (CI), else `../.env.local` (build scripts run with cwd = the
    // package root, src-tauri/, so the repo-root file is one level up).
    // Empty/missing -> the consuming feature cleanly no-ops. Keys end up
    // only in the compiled binary (same exposure as any client-embedded
    // key — acceptable for free, rate-limited ones), never in source
    // control. `env!("AURA_MDBLIST_KEY")` reads this in ratings.rs;
    // `env!("AURA_PUBLICMETADB_KEY")` in publicmetadb.rs.
    let env_file = parse_dotenv("../.env.local");

    let mdblist_key      = resolve_secret(&env_file, "AURA_MDBLIST_KEY");
    let publicmetadb_key = resolve_secret(&env_file, "AURA_PUBLICMETADB_KEY");

    println!("cargo:rustc-env=AURA_MDBLIST_KEY={mdblist_key}");
    println!("cargo:rustc-env=AURA_PUBLICMETADB_KEY={publicmetadb_key}");
    println!("cargo:rerun-if-changed=../.env.local");
    println!("cargo:rerun-if-env-changed=AURA_MDBLIST_KEY");
    println!("cargo:rerun-if-env-changed=AURA_PUBLICMETADB_KEY");

    // Custom Windows manifest: tauri-build's default has NO <compatibility>
    // section, so Windows version-lies 6.2 to the process and libmpv's
    // d3d11 context refuses to configure the swapchain colorspace
    // (IsWindows10OrGreater() == false) — HDR output renders PQ-into-sRGB,
    // i.e. washed-out. See windows-app-manifest.xml for the full story.
    println!("cargo:rerun-if-changed=windows-app-manifest.xml");
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("failed to run tauri-build");
}
