// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Optional Sentry DSN baked in at build time. The runtime
   *  `crash_reporting_dsn` setting takes precedence when both are set
   *  so users can paste a different DSN without a rebuild. */
  readonly VITE_SENTRY_DSN?: string;
  /** Aura version string read from package.json by vite.config.ts.
   *  Used as Sentry's release tag. */
  readonly VITE_APP_VERSION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
