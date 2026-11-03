import { createHarness } from "./harness.ts";
import { MacosDriver } from "../src/platform/macos/driver.ts";
import { ONE_APP, stubTransport } from "./macos-fixtures.ts";

type Check = (label: string, ok: boolean, detail?: string) => void;

export async function checkMacosFieldIdentity(check: Check): Promise<void> {
  // ── A document area and a find field are not the same kind of thing ─────────────────
  // Measured by losing a document: driving TextEdit through this platform, AXTextArea and
  // AXSearchField both rendered as a nameless `textbox`, the two sat next to each other in the
  // listing, and a set_text meant for the find field replaced the whole document.
  {
    const fb = stubTransport();
    fb.findBar = true;
    const fh = createHarness(new MacosDriver({ transport: fb.transport, ...ONE_APP }));
    const els = (await fh.api.observe()).elements;
    const doc = els.find((e) => e.role === "textbox" && (e.state ?? "").includes("第一行"));
    const search = els.find((e) => e.role === "searchbox");
    check("a search field is a searchbox, not another textbox", !!search,
      JSON.stringify(els.filter((e) => /box$/.test(e.role)).map((e) => `${e.ref} ${e.role} ${e.name}`)));
    check("…and the document area is still a textbox, so the two never collide in the listing",
      !!doc && doc.ref !== search?.ref);

    // The second half of the same fix: where a control has no name at all, the app developer's
    // own id for it is the only thing left. Marked `#` — nothing on screen says it.
    check("a nameless control is named by its AXIdentifier, marked as developer text",
      doc?.name === "#First Text View", JSON.stringify(doc?.name));
    // The VALUE is identity too: Finder names a file row nowhere — the filename is the value of
    // an unnamed textbox — so without it the most ordinary target there is cannot be named.
    // The document area here has the same
    // shape: a value, and a name that is only a developer id.
    const byValue = await fh.api.find("第一行");
    check("a control with no name of its own is findable by the VALUE it holds",
      byValue?.ref === doc?.ref, `${byValue?.ref} vs ${doc?.ref}`);
    check("…and the handle says so, because the caller asked by name and this one has no such name",
      (byValue as { byValue?: boolean } | null)?.byValue === true, JSON.stringify(byValue));
    const byId = await fh.api.find("#First Text View");
    check("…and that name is findable, so it is a way IN and not just a label",
      !!byId && (byId as { ref: string }).ref === doc?.ref, JSON.stringify(byId ?? null));
    check("a control with no id and no name still gets neither — nothing is invented",
      search?.name === "", JSON.stringify(search?.name));

  }

}
