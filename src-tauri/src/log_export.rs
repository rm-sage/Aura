// Aura — © 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

//! DevConsole log export — opens a native "Save As…" dialog so the user
//! can choose where to write the current log buffer. Bypasses the
//! browser's download default-folder behavior (which doesn't always
//! prompt, depending on the user's Edge/WebView2 download settings)
//! and writes through std::fs so we get a real OS save path back.

use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{
    FileOpenDialog, FileSaveDialog, IFileOpenDialog, IFileSaveDialog, FOS_PICKFOLDERS,
    SIGDN_FILESYSPATH,
};

/// Open a native Windows "Save As…" dialog seeded with `default_name`,
/// then write `content` to the chosen path as UTF-8.
///
/// Returns `Ok(Some(path))` on success, `Ok(None)` if the user
/// cancels, and `Err(msg)` on COM / IO failure.
#[tauri::command]
pub async fn save_text_with_dialog(
    content: String,
    default_name: String,
) -> Result<Option<String>, String> {
    // The dialog blocks until the user picks or cancels, so push it to
    // a blocking thread to keep the async runtime free.
    tokio::task::spawn_blocking(move || show_and_write(&default_name, &content))
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn show_and_write(default_name: &str, content: &str) -> Result<Option<String>, String> {
    unsafe {
        // CoInitializeEx returns S_FALSE if already initialized on this
        // thread, which is fine — we only need it to be initialized,
        // not exclusively owned.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let dialog: IFileSaveDialog =
            CoCreateInstance(&FileSaveDialog, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(FileSaveDialog) failed: {e}"))?;

        // Seed the filename field. The user can still rename and change
        // extension; we don't lock the file type filter.
        let hname = windows::core::HSTRING::from(default_name);
        dialog
            .SetFileName(&hname)
            .map_err(|e| format!("SetFileName failed: {e}"))?;

        // None owner → owner-less modal. The dialog still respects
        // foreground rules and centers on the active monitor.
        match dialog.Show(None) {
            Ok(()) => {
                let item = dialog
                    .GetResult()
                    .map_err(|e| format!("GetResult failed: {e}"))?;
                let path_pwstr = item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|e| format!("GetDisplayName failed: {e}"))?;
                let path = path_pwstr
                    .to_string()
                    .map_err(|e| format!("path conversion: {e}"))?;
                // Free the COM-allocated buffer.
                windows::Win32::System::Com::CoTaskMemFree(Some(path_pwstr.0 as *const _));

                std::fs::write(&path, content)
                    .map_err(|e| format!("write {path}: {e}"))?;
                Ok(Some(path))
            }
            Err(e) => {
                // ERROR_CANCELLED (0x800704C7) — user clicked Cancel /
                // closed the dialog. Surface as Ok(None) so the
                // frontend can silently no-op.
                const ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;
                if e.code().0 == ERROR_CANCELLED {
                    Ok(None)
                } else {
                    Err(format!("dialog Show failed: {e}"))
                }
            }
        }
    }
}

/// Open a native Windows folder picker. Returns the chosen directory path,
/// `Ok(None)` if the user cancels, `Err` on COM failure. Used by Settings to
/// configure the screenshot output directory.
#[tauri::command]
pub async fn pick_folder() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(show_folder_picker)
        .await
        .map_err(|e| format!("join error: {e}"))?
}

fn show_folder_picker() -> Result<Option<String>, String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let dialog: IFileOpenDialog =
            CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
                .map_err(|e| format!("CoCreateInstance(FileOpenDialog) failed: {e}"))?;

        // Add FOS_PICKFOLDERS to the default options so the dialog selects a
        // directory instead of a file.
        let opts = dialog
            .GetOptions()
            .map_err(|e| format!("GetOptions failed: {e}"))?;
        dialog
            .SetOptions(opts | FOS_PICKFOLDERS)
            .map_err(|e| format!("SetOptions failed: {e}"))?;

        match dialog.Show(None) {
            Ok(()) => {
                let item = dialog
                    .GetResult()
                    .map_err(|e| format!("GetResult failed: {e}"))?;
                let path_pwstr = item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|e| format!("GetDisplayName failed: {e}"))?;
                let path = path_pwstr
                    .to_string()
                    .map_err(|e| format!("path conversion: {e}"))?;
                windows::Win32::System::Com::CoTaskMemFree(Some(path_pwstr.0 as *const _));
                Ok(Some(path))
            }
            Err(e) => {
                const ERROR_CANCELLED: i32 = 0x800704C7u32 as i32;
                if e.code().0 == ERROR_CANCELLED {
                    Ok(None)
                } else {
                    Err(format!("dialog Show failed: {e}"))
                }
            }
        }
    }
}
