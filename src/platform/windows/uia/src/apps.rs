//! Starting an app: the Start menu's own list (`shell:AppsFolder`, desktop and Store apps alike)
//! and `ShellExecuteEx`. Which window the launch produced is the driver's question, not this one's:
//! a Store app's window belongs to another process than the one started, and a single-instance
//! app answers by bringing its existing window forward.
//!
//! `info` answers which PROGRAM a name would start without starting it: the driver asks the user
//! about an app before it launches one, and has to ask about it by the name its window will be
//! listed under.

use serde_json::{json, Value};

use windows::core::{w, Interface, GUID, HSTRING, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, ERROR_SUCCESS};
use windows::Win32::Storage::Packaging::Appx::{GetPackagePathByFullName, GetPackagesByPackageFamily};
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Threading::GetProcessId;
use windows::Win32::UI::Shell::PropertiesSystem::PROPERTYKEY;
use windows::Win32::UI::Shell::{
    BHID_EnumItems, FOLDERID_AppsFolder, IEnumShellItems, IShellItem, IShellItem2, SHGetKnownFolderItem, ShellExecuteExW, KF_FLAG_DEFAULT,
    SEE_MASK_FLAG_NO_UI, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, SIGDN, SIGDN_NORMALDISPLAY, SIGDN_PARENTRELATIVEPARSING,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

use crate::manifest::{exe_stem, executable, run_stem};
use crate::{fail, Fail, Reply};

/// `System.Link.TargetParsingPath`: the file a desktop app's Start-menu shortcut runs.
const LINK_TARGET: PROPERTYKEY = PROPERTYKEY { fmtid: GUID::from_u128(0xb9b4b3fc_2b51_4a42_b5d8_324146afcf25), pid: 2 };

/// One Start-menu entry. The id is the AppUserModelID of a packaged app
/// (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`) or a desktop app's path/known-folder form.
struct Entry {
    name: String,
    id: String,
    item: IShellItem,
}

fn display(item: &IShellItem, kind: SIGDN) -> Option<String> {
    unsafe {
        let p = item.GetDisplayName(kind).ok()?;
        let s = p.to_string().ok();
        CoTaskMemFree(Some(p.0 as *const _));
        s
    }
}

/// Every Start-menu entry.
fn entries() -> Result<Vec<Entry>, Fail> {
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
                out.push(Entry { name, id, item });
            }
        }
    }
    Ok(out)
}

pub fn list() -> Reply {
    let mut apps = entries()?;
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(json!({ "apps": apps.into_iter().map(|e| json!({ "name": e.name, "id": e.id })).collect::<Vec<Value>>() }))
}

/// The Start-menu entry `app` means — by id, else by its name as listed (any case) — or None for
/// a name the Start menu does not have, which is then the Run box's to resolve. Names are what a
/// person says; an ambiguous one is refused with the candidates rather than guessed.
fn pick<'a>(all: &'a [Entry], app: &str) -> Result<Option<&'a Entry>, Fail> {
    if let Some(e) = all.iter().find(|e| e.id.eq_ignore_ascii_case(app)) {
        return Ok(Some(e));
    }
    let by_name: Vec<&Entry> = all.iter().filter(|e| e.name.to_lowercase() == app.to_lowercase()).collect();
    match by_name.as_slice() {
        [] => Ok(None),
        [e] => Ok(Some(e)),
        _ => {
            let ids: Vec<&str> = by_name.iter().map(|e| e.id.as_str()).collect();
            Err(fail("ambiguous", format!("several Start-menu entries are named \"{app}\"; launch one by id: {}", ids.join(", "))))
        }
    }
}

/// The program a packaged app runs, from its package's manifest: the family is everything before
/// the `!` of its AppUserModelID, the app's id within the package everything after.
fn packaged_exe(family: &str, app_id: &str) -> Option<String> {
    let family = HSTRING::from(family);
    unsafe {
        // Sized by a first call that fails for want of a buffer.
        let (mut count, mut len) = (0u32, 0u32);
        let _ = GetPackagesByPackageFamily(&family, &mut count, None, &mut len, PWSTR::null());
        if count == 0 || len == 0 {
            return None;
        }
        let mut names = vec![PWSTR::null(); count as usize];
        let mut buf = vec![0u16; len as usize];
        if GetPackagesByPackageFamily(&family, &mut count, Some(names.as_mut_ptr()), &mut len, PWSTR(buf.as_mut_ptr())) != ERROR_SUCCESS {
            return None;
        }
        for full in names.iter().take(count as usize) {
            let mut path_len = 0u32;
            let _ = GetPackagePathByFullName(PCWSTR(full.0), &mut path_len, PWSTR::null());
            if path_len == 0 {
                continue;
            }
            let mut path = vec![0u16; path_len as usize];
            if GetPackagePathByFullName(PCWSTR(full.0), &mut path_len, PWSTR(path.as_mut_ptr())) != ERROR_SUCCESS {
                continue;
            }
            let dir = String::from_utf16_lossy(&path).trim_end_matches('\0').to_string();
            let Ok(xml) = std::fs::read(format!("{dir}\\AppxManifest.xml")) else { continue };
            if let Some(exe) = executable(&String::from_utf8_lossy(&xml), app_id) {
                return Some(exe);
            }
        }
    }
    None
}

/// The program an entry runs, by the name its process is listed under (`CalculatorApp`,
/// `WINWORD`); None when the entry does not say (a link to a document, a hosted web app).
fn entry_exe(e: &Entry) -> Option<String> {
    if let Some((family, app_id)) = e.id.split_once('!') {
        return packaged_exe(family, app_id);
    }
    let target = unsafe {
        e.item.cast::<IShellItem2>().ok().and_then(|item| item.GetString(&LINK_TARGET).ok()).and_then(|p| {
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            s
        })
    };
    target.as_deref().and_then(exe_stem).or_else(|| exe_stem(&e.id))
}

/// What `launch` would start for `app`, without starting it: the same resolution, plus the
/// program's name (`exe`, null when it cannot be told ahead of the launch).
pub fn info(app: &str) -> Reply {
    let app = app.trim();
    if app.is_empty() {
        return Err(fail("bad_request", "appinfo needs an app: a Start-menu name or id, or a program name"));
    }
    let all = entries().unwrap_or_default();
    Ok(match pick(&all, app)? {
        Some(e) => json!({ "name": e.name, "id": e.id, "via": "start_menu", "exe": entry_exe(e) }),
        None => json!({ "name": app, "via": "shell", "exe": run_stem(app) }),
    })
}

/// Start `app`: a Start-menu id, a Start-menu name (as listed, any case), or anything the Run box
/// takes (`notepad`, `mspaint.exe`, a full path).
pub fn launch(app: &str) -> Reply {
    let app = app.trim();
    if app.is_empty() {
        return Err(fail("bad_request", "launch needs an app: a Start-menu name or id, or a program name"));
    }
    let all = entries().unwrap_or_default();
    let (file, name, via) = match pick(&all, app)? {
        Some(e) => (format!("shell:AppsFolder\\{}", e.id), e.name.clone(), "start_menu"),
        None => (app.to_string(), app.to_string(), "shell"),
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
