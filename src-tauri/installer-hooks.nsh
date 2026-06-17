; Aura NSIS installer hooks (wired via tauri.conf.json > bundle.windows.nsis.installerHooks).
;
; PREINSTALL runs immediately before the installer extracts files (including
; aura.exe). Since Aura moved its large binaries (libmpv / ffmpeg / ffprobe) to
; on-demand downloads, the installer shrank from ~314 MB to a few MB and now
; reaches the aura.exe overwrite almost instantly during an auto-update — faster
; than the just-closed app and its WebView2 helper processes can release the
; file lock. The symptom is NSIS's "error opening file for writing: aura.exe".
;
; The old fat installer never hit this because extracting ~300 MB of bundled
; binaries first gave the exiting process several seconds to let go. We restore
; that delay deterministically, without re-bloating every update: pause briefly
; so the old process and its child handles are gone before extraction begins.
; A few seconds on an install/update is imperceptible; the app's own shutdown is
; bounded to ~2.5 s, so this comfortably outlasts it.
!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Waiting for any previous Aura instance to close..."
  Sleep 3000
!macroend
