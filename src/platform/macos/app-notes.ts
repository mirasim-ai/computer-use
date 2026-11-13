/**
 * What this platform KNOWS about particular applications — delivered to the model once, the first
 * time a session observes that app, in the observation's own text (`MacosDriver.renderHeadLines`).
 *
 * These are facts a tree walk cannot yield and a model cannot guess: an app that accepts a write
 * and discards it, an action a control advertises and does not honour, a panel that belongs to
 * another process. Every one is MEASURED; an app we have not actually driven gets no entry, since
 * a note written from imagination is believed.
 *
 * WHY THIS FILE RATHER THAN THE PROMPT. `promptFragmentFor` (prompt-fragment.ts) is resident in
 * every macOS session (~3,100 characters), so an app-specific sentence there is charged to every
 * session that never opens that app. Here a fact is paid for only when the app is actually under
 * the driver.
 *
 * HOW TO WRITE ONE. Address the model, not a reader of this repo: say what would go wrong and what
 * to do instead. Keep it to the scale of the facts — a few hundred tokens at most. State only what
 * was measured; where the app's own behaviour is a setting the user controls, say how to READ it
 * rather than guessing a default.
 */

/** Keyed by bundle id, exactly as `AxApp.bundle` reports it — never a display name, which is
 *  localised (Finder and Calculator have other names on a Chinese-locale machine). */
const APP_NOTES: Record<string, string> = {
  "com.apple.finder": `Finder, known quirks:
- RENAMING a file does not work with set_text. The name cell accepts AXSetValue and reads the new
  name back, and the file keeps its old name — the cell commits on Enter and starts a fresh edit.
  The route that works is: select the row, keys('Enter') to open the editor, type({text}) the new
  name, keys('Enter') to commit. A field that offers AXConfirm says so in its set_text result; that
  is the same warning.
- The rename editor is a transient untitled WINDOW while it is open, so an "opened a window" note
  and a surfaces() entry that vanishes after Enter are both expected, not a problem.`,

  "com.apple.systempreferences": `System Settings, known quirks:
- The SIDEBAR builds its rows as they scroll in. Rows past the window are listed as nameless rows,
  so find() misses a pane that is further down (measured: 14 of the 30-odd panes named with the
  list at its top). Page it by naming any sidebar item: scroll({direction:'down', ref}) works with
  the app in the background; then find the pane and click it. A row that has scrolled far out of
  the window loses its name again after a while, and pressing one that is still outside the window
  can be refused (AXError -25202): bring it into the window first.
- A sheet raised inside a pane (Internet Accounts › Add Account…, and the forms behind it) is in
  THIS window's element list, not a surface of its own: keep the handle and wait for the control
  you expect. The click that opens one names what appeared, by ref, so the next click can follow
  in the same call. A list that grows past the window's edge (Add Other Account…) answers
  "reported changes … though nothing listed inside the window differs": the click worked, and
  the new rows are past the edge — find them, they take a click by ref where they are.
- wait({}) here goes by the app's change notifications (about half a second); reading the text
  twice never agrees, because the sidebar renames its rows on every read.
- The pane names in the View menu need the window to be key, so menu() does not run them in the
  background; the sidebar is the background route.
- The steps differ between macOS versions (27 puts an "enter your email address" sheet before the
  provider list): observe each sheet instead of waiting for a control name from memory.`,

  "com.apple.TextEdit": `TextEdit, known quirks:
- Every item of a context menu advertises AXCancel, and running it does NOTHING — the menu stays
  up and the verdict reads frozen. Close a menu with keys('Escape'); pick an item with click.
- An Open or Save panel is not TextEdit: it is a remote view hosted by openAndSavePanelService.
  keys() goes to that panel's own process, but a ⌘-chord there (⌘⇧G Go To Folder) takes effect only
  with the app frontmost. Drive it BY REF — its Cancel button, its name field and its format popup
  all answer accessibility normally, in the background too.`,

  "com.apple.calculator": `Calculator, known quirks:
- Its toolbar buttons (Show Sidebar, Mode) advertise AXIncrement, AXDecrement and
  AXCancel. None of them do anything — they are NSAccessibility defaults for the control class, not
  capabilities a toolbar button has. Click them instead of reaching for ax_action.`,

  "com.apple.QuickTimePlayerX": `QuickTime Player, known quirks:
- Its playback controls exist only while the pointer is ON the window, and they leave the tree
  about three seconds after the pointer stops (measured: 27 elements at 0-2s, 5 at 3s). A plain
  observe() shows five window-chrome elements and no player at all. So hover({x, y}) over the video
  and ACT IN THE SAME CALL — a ref minted in one call is dead in the next, and re-observing without
  a hover will list those same five for ever, whatever the stale-ref advice says.
- The Timeline slider takes set_text and discards it (the value reads back unchanged), and AXDecrement
  on it does nothing. Move the playhead with Rewind / Fast Forward — one click starts a CONTINUOUS 5x scan
  that only Play/Pause stops — or drag the slider.`,

  "org.blenderfoundation.blender": `Blender, known quirks:
- Its shortcuts are routed by the region under the POINTER, not by the window's focus: keys sent
  while the pointer sits outside the 3D viewport reach whatever area it is over instead. Put it
  there first with hover({x, y}) off a screenshot, then send the key.
- Modifier CHORDS do not arrive. keys('shift+a') acted as plain 'a' (select all, measured) and
  keys('alt+a') did nothing, while bare keys land normally ('a', Return, Escape). Reach for a
  single-key route, and check the screenshot rather than trusting the chord.
- It has a scripting CLI of its own, which is the route for anything that is really a FILE or
  SCENE operation rather than a look at the interface:
  \`blender --background <file.blend> --python-expr '<python>'\` (verified: bpy.ops added an
  object and printed the scene graph). Hand that path back to whoever asked instead of driving
  pixels for it; the GUI is for what only the GUI shows.`,

  "com.google.Chrome": `Chrome, known quirks:
- ax_action('menu') on the ADDRESS BAR answers AXError -25204 and then opens the menu anyway,
  sometimes about 800 ms later, sometimes not at all. Treat the error as a report about the call
  and not a verdict on the effect: observe before deciding it failed, and give it a beat.`,

  "com.microsoft.Excel": `Excel, known quirks:
- THE SHEET IS NOT IN THE TREE until a real mouse click lands in a cell. Until then the window is
  ribbon only, with no cell at all. One click({x, y}) inside the grid — coordinates read off
  observe({screenshot:true}) — publishes the whole used range, and it stays for the rest of the
  session. Navigating with the name box does NOT do it: set_text is AXSetValue, not a click.
- After it: a filled cell is a textbox named by its address whose value is its content, an empty one
  a cell named by its address, and text() renders the sheet row by row. Read the table from there
  rather than one cell at a time.
- Before it, the only read is one cell at a time: set_text the name box to an address, Enter, then
  read the FORMULA BAR ELEMENT'S NAME — "Formula Bar. B,4 =SUM(B2:B3)" carries the address and the
  content together. Its own value is always empty and its state says empty; believe neither.`,

  "com.microsoft.Word": `Word, known quirks:
- set_text on the document body answers success and writes NOTHING (the read-back is empty). Type
  into it instead. Word also autocorrects what arrives, so the text you read back may differ from
  the text you sent — compare meaning, not bytes.
- The ribbon's Bold checkbox never changes state, whether or not the format applied. Decide by
  the UNDO menu item, whose name becomes "Undo Bold" when it did.`,

  "com.microsoft.Powerpoint": `PowerPoint, known quirks:
- The slide canvas is not in the tree, and neither is the outline view — the window is ribbon plus
  one thumbnail cell. Typing reaches the focused placeholder anyway, but nothing in the tree will
  confirm it: verify with a screenshot.`,

  "com.microsoft.VSCode": `Visual Studio Code, known quirks:
- ITS WINDOW CAN READ AS EMPTY. Measured cold: three nameless buttons, no web area, text() empty —
  the editor had not published its content to accessibility, and the accessibility switch this
  platform sets answers success without changing that for far longer than one read waits. It DID
  come alive later in the same session (3 elements → 96) and stayed alive afterwards, so reading
  again is worth one call before giving up.
- While it reads as empty, two routes still work and neither needs the tree: its MENU carries the
  whole command set (209 commands runnable with the app in the background, the Command Palette
  among them), and a control you can see is reachable by position — observe({screenshot: true}),
  then click({x, y}).`,

  "com.openai.codex": `ChatGPT, known quirks:
- The composer's VALUE is its own placeholder when it is empty: it reads filled:Do anything with
  nothing typed in it, because Chromium puts placeholder text in the value and offers no separate
  placeholder attribute. A web field whose value is exactly its own label is probably empty — do
  not treat it as a draft to preserve.
- The header toggles never change state. Toggle side panel, Toggle bottom panel and Toggle summary
  read unchecked whether their panel is open or shut. Decide by what the observation CONTAINS — an
  open side panel brings a tablist (Side chat / Browser / Terminal) and a second composer with it —
  never by the toggle, and never report "it was already open" from reading one. Controls inside the
  panel do report their own state.
- Settings (cmd+,) replaces the whole window rather than opening one: the composer, the header and
  every ref you are holding go away, while the window keeps the conversation's title. Escape does
  NOT leave it. Click the Back to app link.`,
};

/**
 * What to know about a Save panel, said once per session the first time one is in an observation
 * (its name field's identifier is `saveAsNameTextField`). Not an app's note: the panel is
 * openAndSavePanelService's remote view and looks the same inside every app.
 */
export const SAVE_PANEL_NOTE = `Save panel, known quirks:
- A folder in the sidebar (Desktop, Documents, Downloads…): click its row, the unnamed cell listed
  just before the folder's text. Where: then names that folder.
- Parent folders and Recent Places: click the Where: popup, then click the menu item.
- A folder inside the file list: in column view the list exposes no rows at all. Switch the view
  button (column view) to List, then ax_action AXOpen on the folder's row — it answers AXError
  -25205 and opens the folder anyway; read Where: to confirm. The view choice is saved for every
  app's Save panel, so switch back to Columns before pressing Save.
- Only a file name goes in Save As:. ⌘⇧G Go To Folder works only with the app frontmost.`;

/** The note for an app, or null. Bundle ids are compared case-insensitively: the walk reports what
 *  the app declares, and macOS itself treats them without regard to case. */
export function appNote(bundle: string | null | undefined): string | null {
  if (!bundle) return null;
  const want = bundle.trim().toLowerCase();
  for (const [id, note] of Object.entries(APP_NOTES)) if (id.toLowerCase() === want) return note;
  return null;
}
