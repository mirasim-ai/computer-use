//! Observe interference; never restore focus or replay an action. Detection cannot undo a popup.
use std::sync::{Arc, atomic::{AtomicBool, Ordering}};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use windows::Win32::UI::Accessibility::{IUIAutomation, IUIAutomationElement};
use windows::Win32::UI::WindowsAndMessaging::{GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsWindow, GA_ROOT, GUITHREADINFO};
use crate::{fail, win, Fail};

#[derive(Clone, Copy, PartialEq)]
struct InputState { foreground: isize, focus: isize }

impl InputState {
    fn read() -> Option<Self> {
        unsafe {
            let foreground = GetForegroundWindow();
            if foreground.0.is_null() { return None; }
            let thread = GetWindowThreadProcessId(foreground, None);
            let mut info = GUITHREADINFO { cbSize: std::mem::size_of::<GUITHREADINFO>() as u32, ..Default::default() };
            GetGUIThreadInfo(thread, &mut info).ok()?;
            Some(Self { foreground: GetAncestor(foreground, GA_ROOT).0 as isize, focus: info.hwndFocus.0 as isize })
        }
    }
}

fn owned(hwnd: isize) -> Vec<isize> {
    win::owned(win::hwnd(hwnd)).iter().map(|h| h.0 as isize).collect()
}

pub struct BackgroundGuard {
    stop: Arc<AtomicBool>,
    changed: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    input: InputState,
    focused: Option<IUIAutomationElement>,
    windows: Vec<isize>,
}

impl BackgroundGuard {
    pub fn begin(a: &IUIAutomation, hwnd: isize) -> Result<Self, Fail> {
        let input = InputState::read().ok_or_else(|| fail("background_unsupported", "background actions need an observable interactive desktop; nothing was sent"))?;
        let focused = unsafe { a.GetFocusedElement() }.ok();
        let windows = owned(hwnd);
        let initial_windows = windows.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let changed = Arc::new(AtomicBool::new(false));
        let (done, interrupted) = (stop.clone(), changed.clone());
        let worker = thread::Builder::new().name("uia-background-observer".into()).spawn(move || {
            let mut tick = 0u32;
            while !done.load(Ordering::Acquire) {
                if InputState::read() != Some(input) || (tick % 4 == 0 && owned(hwnd).iter().any(|h| !initial_windows.contains(h))) {
                    interrupted.store(true, Ordering::Release);
                }
                tick = tick.wrapping_add(1);
                thread::sleep(Duration::from_millis(5));
            }
        }).map_err(|_| fail("background_unsupported", "could not start the background observer; nothing was sent"))?;
        Ok(Self { stop, changed, worker: Some(worker), input, focused, windows })
    }

    pub fn finish(mut self, a: &IUIAutomation, hwnd: isize) -> bool {
        let after_focus = unsafe { a.GetFocusedElement() }.ok();
        let same_focus = match (&self.focused, &after_focus) {
            (Some(before), Some(after)) => unsafe { a.CompareElements(before, after) }.is_ok_and(|b| b.as_bool()),
            (None, None) => true,
            _ => false,
        };
        let changed = !same_focus || InputState::read() != Some(self.input)
            || !unsafe { IsWindow(win::hwnd(hwnd)) }.as_bool()
            || owned(hwnd).iter().any(|h| !self.windows.contains(h));
        self.stop();
        changed || self.changed.load(Ordering::Acquire)
    }

    fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

impl Drop for BackgroundGuard { fn drop(&mut self) { self.stop(); } }
