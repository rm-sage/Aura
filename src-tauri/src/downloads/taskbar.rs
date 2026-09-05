// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Aggregate download progress on the Windows taskbar button, the way a
//! browser shows a download filling its own icon.
//!
//! Uses `ITaskbarList3`, a superset of the `ITaskbarList2` `win32.rs:42`
//! already binds for `MarkFullscreenWindow`, so the `Win32_UI_Shell` feature is
//! already enabled and no Cargo change is needed for this file.
//!
//! Every call is best-effort. A failure here must never affect a download: the
//! taskbar is decoration, and Explorer can be restarting.

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::Mutex;

    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        ITaskbarList3, TaskbarList, TBPF_ERROR, TBPF_NOPROGRESS, TBPF_NORMAL, TBPF_PAUSED,
    };

    /// Last state pushed, so an idle app does not re-issue the same COM call
    /// twice a second forever.
    static LAST: Mutex<Option<(u32, u64)>> = Mutex::new(None);

    fn hwnd() -> Option<HWND> {
        use tauri::Manager;
        let app = super::super::manager::app()?;
        let win = app.get_webview_window("main")?;
        win.hwnd().ok()
    }

    pub fn apply(state: u32, permille: u64) {
        {
            let mut last = LAST.lock().unwrap();
            if *last == Some((state, permille)) {
                return;
            }
            *last = Some((state, permille));
        }
        let Some(h) = hwnd() else { return };
        unsafe {
            // The shell COM apartment may not be initialised on this thread.
            // Re-initialising an already-initialised STA returns S_FALSE, which
            // is harmless.
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let Ok(list) = CoCreateInstance::<_, ITaskbarList3>(
                &TaskbarList,
                None,
                CLSCTX_INPROC_SERVER,
            ) else {
                return;
            };
            if list.HrInit().is_err() {
                return;
            }
            let flag = match state {
                1 => TBPF_NORMAL,
                2 => TBPF_PAUSED,
                3 => TBPF_ERROR,
                _ => TBPF_NOPROGRESS,
            };
            let _ = list.SetProgressState(h, flag);
            if state != 0 {
                let _ = list.SetProgressValue(h, permille, 1000);
            }
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub fn apply(_state: u32, _permille: u64) {}
}

/// Recompute and push the aggregate. Called from the manager's ticker and after
/// every control action.
pub fn update() {
    let snap = super::manager::snapshot();
    let any_failed = snap
        .jobs
        .iter()
        .any(|j| j.job.state == super::types::DownloadState::Failed);
    let any_running = snap
        .jobs
        .iter()
        .any(|j| j.job.state == super::types::DownloadState::Running);

    // Precedence is deliberate: a running transfer is what the user wants to
    // watch, so an old failure must not pin the button red while something is
    // actively downloading.
    if any_running {
        match snap.overall {
            Some(f) => imp::apply(1, (f.clamp(0.0, 1.0) * 1000.0) as u64),
            // Running but no size known yet. Windows has no indeterminate
            // taskbar state that is not a marquee, and a marquee here would
            // read as "stuck", so show a small definite sliver instead.
            None => imp::apply(1, 20),
        }
    } else if snap.active > 0 {
        imp::apply(2, snap.overall.map(|f| (f * 1000.0) as u64).unwrap_or(0));
    } else if any_failed {
        imp::apply(3, 1000);
    } else {
        imp::apply(0, 0);
    }
}
