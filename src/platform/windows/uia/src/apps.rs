//! Starting an app: the Start menu's own list (`shell:AppsFolder`, desktop and Store apps alike)
//! and `ShellExecuteEx`. Which window the launch produced is the driver's question, not this one's:
//! a Store app's window belongs to another process than the one started, and a single-instance
//! app answers by bringing its existing window forward.

use serde_json::{json, Value};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, SHGetKnownFolderItem, ShellExecuteExW, KF_FLAG_DEFAULT,
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::{fail, Fail, Reply};

fn display(item: &IShellItem, kind: SIGDN) -> Option<String> {
    unsafe {
        let p = item.GetDisplayName(kind).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// Every Start-menu entry as (display name, id). The id is the AppUserModelID of a packaged app
/// (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`) or a desktop app's path/known-folder form.
fn entries() -> Result<Vec<(String, String)>, Fail> {
    let mut out = Vec::new();
    unsafe {
        let folder: IShellItem = SHGetKnownFolderItem(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, None)?;
        let items: IEnumShellItems = folder.BindToHandler(None, &BHID_EnumItems)?;
        loop {
            let mut one = [None];
            let mut fetched = 0u32;
            if items.Next(&mut one, Some(&mut fetched)).is_err() || fetched == 0 {
                break;
            }
            let Some(item) = one[0].take() else { break };
            if let (Some(name), Some(id)) = (display(&item, SIGDN_NORMALDISPLAY), display(&item, SIGDN_PARENTRELATIVEPARSING)) {
                out.push((name, id));
            }
        }
    }
    Ok(out)
}

pub fn list() -> Reply {
    let mut apps = entries()?;
    apps.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    Ok(json!({ "apps": apps.into_iter().map(|(name, id)| json!({ "name": name, "id": id })).collect::<Vec<Value>>() }))
}

/// Start `app`: a Start-menu id, a Start-menu name (as listed, any case), or anything the Run box
/// takes (`notepad`, `mspaint.exe`, a full path). Names are matched first because they are what a
/// person says; an ambiguous name is refused with the candidates rather than guessed.
pub fn launch(app: &str) -> Reply {
    let app = app.trim();
    if app.is_empty() {
        return Err(fail("bad_request", "launch needs an app: a Start-menu name or id, or a program name"));
    }
    let all = entries().unwrap_or_default();
    let by_id: Vec<&(String, String)> = all.iter().filter(|(_, id)| id.eq_ignore_ascii_case(app)).collect();
    let by_name: Vec<&(String, String)> = all.iter().filter(|(name, _)| name.to_lowercase() == app.to_lowercase()).collect();
    let (file, name, via) = match (by_id.first(), by_name.as_slice()) {
        (Some((name, id)), _) => (format!("shell:AppsFolder\\{id}"), name.clone(), "start_menu"),
        (None, [(name, id)]) => (format!("shell:AppsFolder\\{id}"), name.clone(), "start_menu"),
        (None, [_, _, ..]) => {
            let ids: Vec<&str> = by_name.iter().map(|(_, id)| id.as_str()).collect();
            return Err(fail("ambiguous", format!("several Start-menu entries are named \"{app}\"; launch one by id: {}", ids.join(", "))));
        }
        (None, []) => (app.to_string(), app.to_string(), "shell"),
    };
    let file_w = HSTRING::from(file.as_str());
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        // NO_UI: a name that resolves to nothing must come back as an error, not as a "Windows
        // cannot find…" message box left on the user's screen.
        fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_FLAG_NO_UI | SEE_MASK_NOASYNC,
        lpVerb: w!("open"),
        lpFile: PCWSTR(file_w.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    if let Err(e) = unsafe { ShellExecuteExW(&mut info) } {
        return Err(fail("not_found", format!("Windows could not start \"{app}\" ({}) — list launchable apps with listApps()", e.message())));
    }
    let pid = if info.hProcess.is_invalid() {
        0
    } else {
        let pid = unsafe { GetProcessId(info.hProcess) };
        unsafe { let _ = CloseHandle(info.hProcess); }
        pid
    };
    Ok(json!({ "name": name, "via": via, "pid": pid }))
}
