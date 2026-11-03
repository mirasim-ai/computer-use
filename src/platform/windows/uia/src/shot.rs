//! Window capture: `PrintWindow(PW_RENDERFULLCONTENT)` first — it renders the window's OWN
//! content even when another window covers it (measured on Electron and XAML windows, 20–50 ms) —
//! and a screen copy of the frame when it returns nothing. Encoded as PNG, base64 on the wire.

use serde_json::{json, Value};

use windows::Win32::Foundation::RECT;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindowVisible};

use crate::{fail, uia::Engine, win, Fail, Reply};

const PW_RENDERFULLCONTENT: u32 = 2;
const MAX_PIXELS: i64 = 32 * 1024 * 1024;

pub fn window(h: isize) -> Reply {
    let frame = capture_frame(h)?;
    let (bgra, method) = pixels(h, frame)?;
    let (fw, fh) = (frame.right - frame.left, frame.bottom - frame.top);
    let png = encode_png(&bgra, fw as u32, fh as u32)?;
    Ok(json!({ "png": base64(&png), "width": fw, "height": fh, "x": frame.left, "y": frame.top, "method": method }))
}

/// Detail uses the same bound-window capture and backend as a full screenshot, without activation.
/// Reading the control's current bounds twice also catches layout changes during capture.
pub fn scoped(h: isize, r: &Value, engine: Option<&Engine>) -> Reply {
    let frame = capture_frame(h)?;
    let (fw, fh) = (frame.right - frame.left, frame.bottom - frame.top);
    let key = r.get("key").and_then(Value::as_str);
    if r.get("fullPage").and_then(Value::as_bool).unwrap_or(false) || key.is_some() == r.get("region").is_some() {
        return Err(fail("bad_request", "pick exactly one of key or region for a scoped window capture"));
    }
    let padding = match r.get("padding") {
        Some(v) if key.is_some() => v.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
            .ok_or_else(|| fail("bad_request", "padding must be finite and nonnegative"))?,
        Some(_) => return Err(fail("bad_request", "padding requires an element key")),
        None => 0.0,
    };
    let element = if let Some(k) = key {
        Some(engine.ok_or_else(|| fail("unsupported", "UI Automation is unavailable"))?.capture_rect(k, h)?)
    } else { None };
    let (x, y, w, height) = if let Some(el) = element {
        (f64::from(el.left) - f64::from(frame.left), f64::from(el.top) - f64::from(frame.top),
            f64::from(el.right) - f64::from(el.left), f64::from(el.bottom) - f64::from(el.top))
    } else {
        // Regions name pixels of a prior full screenshot. Refuse a stale coordinate baseline.
        let f = &r["frame"];
        if number(f, "x")? != f64::from(frame.left) || number(f, "y")? != f64::from(frame.top)
            || number(f, "w")? != f64::from(fw) || number(f, "h")? != f64::from(fh) {
            return Err(fail("geometry_changed", "the window moved or resized since the full screenshot; take a new full screenshot"));
        }
        let region = &r["region"];
        (number(region, "x")?, number(region, "y")?, number(region, "width")?, number(region, "height")?)
    };
    if w <= 0.0 || height <= 0.0 {
        return Err(fail("bad_request", "region width and height must be positive"));
    }
    // Padding cannot rescue a control wholly outside the captured window.
    if x >= f64::from(fw) || y >= f64::from(fh) || x + w <= 0.0 || y + height <= 0.0 {
        return Err(fail("offscreen", "the requested control or region is outside the captured window"));
    }
    let bounds = [(x - padding).floor(), (y - padding).floor(), (x + w + padding).ceil(), (y + height + padding).ceil()];
    if !bounds.iter().all(|v| v.is_finite()) {
        return Err(fail("bad_request", "the requested crop coordinates are too large"));
    }
    let left = bounds[0].clamp(0.0, f64::from(fw)) as i32;
    let top = bounds[1].clamp(0.0, f64::from(fh)) as i32;
    let right = bounds[2].clamp(0.0, f64::from(fw)) as i32;
    let bottom = bounds[3].clamp(0.0, f64::from(fh)) as i32;
    let trimmed = bounds != [f64::from(left), f64::from(top), f64::from(right), f64::from(bottom)];
    let (bgra, method) = pixels(h, frame)?;
    if let (Some(k), Some(before), Some(engine)) = (key, element, engine) {
        if engine.capture_rect(k, h)? != before {
            return Err(fail("geometry_changed", "the control moved or resized during capture; observe it again"));
        }
    }
    let (cw, ch) = (right - left, bottom - top);
    let cropped = crop(&bgra, fw, left, top, cw, ch)
        .ok_or_else(|| fail("capture_failed", "the requested crop has no pixels inside the captured window"))?;
    let png = encode_png(&cropped, cw as u32, ch as u32)?;
    Ok(json!({ "png": base64(&png), "x": frame.left, "y": frame.top, "width": fw, "height": fh,
        "region": { "x": left, "y": top, "width": cw, "height": ch },
        "pixelWidth": cw, "pixelHeight": ch, "trimmed": trimmed, "method": method }))
}

fn number(r: &Value, key: &str) -> Result<f64, Fail> {
    r[key].as_f64().filter(|v| v.is_finite()).ok_or_else(|| fail("bad_request", format!("missing finite number '{key}'")))
}

fn capture_frame(h: isize) -> Result<RECT, Fail> {
    let hw = win::hwnd(h);
    if unsafe { IsIconic(hw).as_bool() } {
        return Err(fail("minimized", "the window is minimized — there are no pixels to capture until it is restored"));
    }
    if !unsafe { IsWindowVisible(hw).as_bool() } {
        return Err(fail("window_gone", "the window is no longer visible to capture"));
    }
    let frame = win::frame(hw).ok_or_else(|| fail("window_gone", "the window has no frame to capture"))?;
    if pixel_len(frame.right - frame.left, frame.bottom - frame.top).is_none() {
        return Err(fail("capture_failed", "the window has invalid bounds or exceeds the 32-megapixel capture budget; resize it"));
    }
    Ok(frame)
}

fn pixels(h: isize, frame: RECT) -> Result<(Vec<u8>, &'static str), Fail> {
    let hw = win::hwnd(h);
    if capture_frame(h)? != frame {
        return Err(fail("geometry_changed", "the window moved or resized before capture; observe it again"));
    }
    let mut outer = RECT::default();
    unsafe { GetWindowRect(hw, &mut outer)? };
    let (fw, fh) = (frame.right - frame.left, frame.bottom - frame.top);

    // PrintWindow draws the whole window rect (invisible resize border included); crop to the frame.
    let full = capture(outer.right - outer.left, outer.bottom - outer.top, |dc| unsafe {
        PrintWindow(hw, dc, PRINT_WINDOW_FLAGS(PW_RENDERFULLCONTENT)).as_bool()
    });
    let (mut pixels, mut method) = (None, "printwindow");
    if let Some(buf) = full {
        if let Some(cropped) = crop(&buf, outer.right - outer.left, frame.left - outer.left, frame.top - outer.top, fw, fh) {
            if !blank(&cropped) {
                pixels = Some(cropped);
            }
        }
    }
    if pixels.is_none() {
        // What the screen shows at the frame — correct only while the window is uncovered.
        method = "screen";
        pixels = capture(fw, fh, |dc| unsafe {
            let screen = GetDC(None);
            let ok = BitBlt(dc, 0, 0, fw, fh, screen, frame.left, frame.top, SRCCOPY).is_ok();
            ReleaseDC(None, screen);
            ok
        });
    }
    let bgra = pixels.ok_or_else(|| fail("capture_failed", "neither PrintWindow nor a screen copy returned pixels"))?;
    if capture_frame(h)? != frame {
        return Err(fail("geometry_changed", "the window moved or resized during capture; observe it again"));
    }
    Ok((bgra, method))
}

fn pixel_len(w: i32, h: i32) -> Option<usize> {
    let pixels = i64::from(w) * i64::from(h);
    if w <= 0 || h <= 0 || pixels > MAX_PIXELS { return None; }
    Some((pixels * 4) as usize)
}

/// Draw into a fresh 32-bit bitmap and read it back top-down as BGRA.
fn capture(w: i32, h: i32, draw: impl FnOnce(HDC) -> bool) -> Option<Vec<u8>> {
    let size = pixel_len(w, h)?;
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(screen);
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bmp);
        let drawn = draw(dc);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // negative: rows top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut buf = vec![0u8; size];
        SelectObject(dc, old);
        let rows = GetDIBits(dc, bmp, 0, h as u32, Some(buf.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS);
        let _ = DeleteObject(bmp);
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        (drawn && rows == h).then_some(buf)
    }
}

fn crop(buf: &[u8], stride_px: i32, x: i32, y: i32, w: i32, h: i32) -> Option<Vec<u8>> {
    let size = pixel_len(w, h)?;
    if stride_px <= 0 || x < 0 || y < 0 || i64::from(x) + i64::from(w) > i64::from(stride_px)
        || (i64::from(y) + i64::from(h)) * i64::from(stride_px) * 4 > buf.len() as i64 {
        return None;
    }
    let mut out = Vec::with_capacity(size);
    for row in y..y + h {
        let start = ((row * stride_px + x) * 4) as usize;
        out.extend_from_slice(&buf[start..start + (w * 4) as usize]);
    }
    Some(out)
}

/// All-black (or empty): what a DirectComposition surface gives a failed PrintWindow.
fn blank(bgra: &[u8]) -> bool {
    bgra.chunks_exact(4).step_by(97).all(|p| p[0] < 8 && p[1] < 8 && p[2] < 8)
}

fn encode_png(bgra: &[u8], w: u32, h: u32) -> Result<Vec<u8>, crate::Fail> {
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for p in bgra.chunks_exact(4) {
        rgb.extend_from_slice(&[p[2], p[1], p[0]]);
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w, h);
    enc.set_color(png::ColorType::Rgb);
    enc.set_depth(png::BitDepth::Eight);
    enc.set_compression(png::Compression::Fast);
    let mut writer = enc.write_header().map_err(|e| fail("capture_failed", e.to_string()))?;
    writer.write_image_data(&rgb).map_err(|e| fail("capture_failed", e.to_string()))?;
    drop(writer);
    Ok(out)
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        s.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    s
}
