fn main() {
    // Bake the MDBList API key into the binary at BUILD time without it
    // ever entering the repo. Source order: env `AURA_MDBLIST_KEY`,
    // else the git-ignored `src-tauri/mdblist.key` file (build scripts
    // run with cwd = package root). Empty/missing → the ratings
    // aggregator's MDBList branch cleanly no-ops. The key ends up only
    // in the compiled binary (same exposure as any client-embedded key
    // — acceptable for a free, rate-limited one), never in source
    // control. `env!("AURA_MDBLIST_KEY")` reads this in ratings.rs.
    let key = std::env::var("AURA_MDBLIST_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("mdblist.key")
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=AURA_MDBLIST_KEY={key}");
    println!("cargo:rerun-if-changed=mdblist.key");
    println!("cargo:rerun-if-env-changed=AURA_MDBLIST_KEY");

    tauri_build::build()
}
