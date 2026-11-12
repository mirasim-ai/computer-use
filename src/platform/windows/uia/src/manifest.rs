//! Which program a Start-menu entry runs, read without starting it: the executable a package
//! manifest names for one of its apps, and the stem of a path. Text in, text out — no Win32 here.

/// `C:\x\WINWORD.EXE` → `WINWORD`: the name a process of that file is listed under.
pub fn exe_stem(path: &str) -> Option<String> {
    let file = path.trim().trim_matches('"').rsplit(['\\', '/']).next()?;
    let (stem, ext) = file.rsplit_once('.')?;
    (ext.eq_ignore_ascii_case("exe") && !stem.is_empty()).then(|| stem.to_string())
}

/// What the Run box would start for `name`: `notepad` and `mspaint.exe` name a program, a full
/// path to one does too; a document, a folder or a `ms-settings:` link names no program at all.
pub fn run_stem(name: &str) -> Option<String> {
    let name = name.trim().trim_matches('"');
    if let Some(stem) = exe_stem(name) {
        return Some(stem);
    }
    (!name.is_empty() && !name.contains(['.', ':', '\\', '/', ' '])).then(|| name.to_string())
}

/// The `Executable` of `<Application Id="app_id" …>` in an AppxManifest.xml. None for an app the
/// manifest does not list, and for one with no executable of its own (a hosted app).
pub fn executable(xml: &str, app_id: &str) -> Option<String> {
    const OPEN: &str = "<Application";
    let mut rest = xml;
    while let Some(at) = rest.find(OPEN) {
        rest = &rest[at + OPEN.len()..];
        // `<Applications>` opens the list; an element's name ends at whitespace.
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let attrs = &rest[..rest.find('>')?];
        if attr(attrs, "Id").is_some_and(|id| id.eq_ignore_ascii_case(app_id)) {
            return attr(attrs, "Executable").and_then(exe_stem);
        }
    }
    None
}

/// The value of attribute `name` among a start tag's attributes. Whole names only: `Id` is not
/// the end of `uap10:HostId`.
fn attr<'a>(attrs: &'a str, name: &str) -> Option<&'a str> {
    let mut from = 0;
    while let Some(at) = attrs[from..].find(name) {
        let start = from + at;
        from = start + name.len();
        if !attrs[..start].ends_with(char::is_whitespace) {
            continue;
        }
        let Some(value) = attrs[from..].trim_start().strip_prefix('=') else { continue };
        let value = value.trim_start();
        let quote = value.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        return value[1..].split(quote).next();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const CALC: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10">
  <Identity Name="Microsoft.WindowsCalculator" Publisher="CN=Microsoft" Version="11.2502.2.0" />
  <Applications>
    <Application Id="App" Executable="CalculatorApp.exe" EntryPoint="CalculatorApp.App">
      <uap:VisualElements DisplayName="ms-resource:AppStoreName" />
    </Application>
    <Application
        Id='Second'
        Executable = "bin\Other Tool.exe" />
    <Application uap10:HostId="PWA" Id="Hosted" uap10:Parameters="x" />
  </Applications>
</Package>"#;

    #[test]
    fn names_the_executable_of_the_app_asked_for() {
        assert_eq!(executable(CALC, "App").as_deref(), Some("CalculatorApp"));
        assert_eq!(executable(CALC, "app").as_deref(), Some("CalculatorApp"));
        assert_eq!(executable(CALC, "Second").as_deref(), Some("Other Tool"));
    }

    #[test]
    fn has_no_answer_for_a_hosted_or_unlisted_app() {
        assert_eq!(executable(CALC, "Hosted"), None);
        assert_eq!(executable(CALC, "PWA"), None);
        assert_eq!(executable(CALC, "Missing"), None);
        assert_eq!(executable("<Package><Applications /></Package>", "App"), None);
    }

    #[test]
    fn stems() {
        assert_eq!(exe_stem(r"C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE").as_deref(), Some("WINWORD"));
        assert_eq!(exe_stem(r"{6D809377-6AF0-444B-8957-A3773F02200E}\Mozilla Firefox\firefox.exe").as_deref(), Some("firefox"));
        assert_eq!(exe_stem("Microsoft.Office.WINWORD.EXE.15"), None);
        assert_eq!(exe_stem("Chrome"), None);
        assert_eq!(run_stem("notepad").as_deref(), Some("notepad"));
        assert_eq!(run_stem("mspaint.exe").as_deref(), Some("mspaint"));
        assert_eq!(run_stem("ms-settings:display"), None);
        assert_eq!(run_stem(r"C:\notes\todo.txt"), None);
    }
}
