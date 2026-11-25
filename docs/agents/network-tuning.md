# Network tuning notes for power users

> Moved verbatim out of the root CLAUDE.md (2026-11-17) to keep it under the size limit; the root keeps a short summary and links here. Read this before changing: user-facing network advice.

## Network tuning notes for power users (host-level, cannot ship from inside the app)

Most users need none of this; Aura's defaults work on a stock Windows install. Try these only on a
high-BDP link (>=100 Mbps x >=30 ms RTT) that rebuffers mid-playback despite the demuxer cache.

- **Windows** (admin `cmd`/PowerShell; inspect with `netsh int tcp show global`):
  `netsh int tcp set global autotuninglevel=experimental` (higher receive-window ceiling);
  `netsh int tcp set supplemental Internet congestionprovider=bbr2` (helps on lossy-but-fast links;
  revert with `cubic`); confirm Receive-Side Scaling is enabled; optionally
  `netsh int tcp set global ecncapability=enabled` for ECN-honoring (e.g. Cloudflare) origins.
- **Linux** (Wine / unofficial build), `/etc/sysctl.conf`: `net.core.default_qdisc=fq`,
  `net.ipv4.tcp_congestion_control=bbr`, and raise `rmem_max` / `wmem_max` / `tcp_rmem` / `tcp_wmem`
  to 16 MiB; `sudo sysctl -p`.
- **Router**: Smart Queue Management (cake / fq_codel) kills buffer bloat; a fast resolver
  (1.1.1.1 / NextDNS) speeds the cold-start DNS lookup. Aura's preheat fetch (`Range: bytes=0-65535`
  in `App.handlePlayStream`) warms the TLS session but cannot help DNS.
- **What NOT to do**: do not disable `https_only`; do not lower `network-timeout` below 60 s (debrid
  hosts can take 30+ s to mux a fresh chunk); do not watch on a Windows "metered connection" (it
  disables TCP autotuning).
