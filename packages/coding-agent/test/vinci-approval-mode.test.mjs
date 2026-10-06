import "../../../vinci/test/ui/env.mjs";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { createVinciUiHarness } from "../../../vinci/test/ui/harness.mjs";

const title = "Vinci — confirm a risky command\n\nThis looks destructive (delete a folder):\n\n  echo disposable\n\nRun it?";
const options = ["No, don't", "Yes, run it", "Always allow this exact command in this project"];
const active = [];
afterEach(async () => { while (active.length) await active.pop().close(); });
async function createUi() {
  const ui = await createVinciUiHarness();
  active.push(ui);
  return ui;
}

describe("Vinci review in production InteractiveMode", () => {
  test("measures the actual custom footer/widget and resets on live resize", async () => {
    const ui = await createUi();
    ui.mode.setExtensionFooter(() => new Text("custom footer\nmodel counter", 0, 0));
    ui.mode.widgetContainerBelow.addChild(new Text("pending widget", 0, 0));
    const choice = ui.mode.showExtensionSelector(title, options, { vinciReviewContext: true });
    const normal = await ui.waitForText("Yes, run it");
    expect(normal).toContain("echo disposable");
    ui.terminal.resize(40, 12);
    const narrow = await ui.waitForText("Review 1/");
    expect(narrow).not.toContain("Yes, run it");
    expect(narrow).toContain("No, don't");
    expect(narrow).toContain("pending widget");
    expect(narrow).toContain("custom footer");
    ui.sendKeys("\x1b");
    expect(await choice).toBeUndefined();
    await ui.settle();
    expect(await ui.screen()).not.toContain("Review 1/");
    const again = ui.mode.showExtensionSelector(title, options, { vinciReviewContext: true });
    await ui.waitForText("Review 1/");
    ui.sendKeys("\r");
    expect(await again).toBe("No, don't");
  });

  test("AbortSignal dismisses context review and restores the editor", async () => {
    const ui = await createUi();
    const controller = new AbortController();
    const choice = ui.mode.showExtensionSelector(title, options, { vinciReviewContext: true, signal: controller.signal });
    await ui.waitForText("Yes, run it");
    controller.abort();
    expect(await choice).toBeUndefined();
    await ui.settle();
    expect(ui.mode.extensionSelector).toBeUndefined();
    expect(ui.mode.editorContainer.children).toContain(ui.mode.editor);
  });

  test("legacy confirm does not inherit the safe-first select-only opt-in", async () => {
    const ui = await createUi();
    // Deliberately exercise untyped callers: the runtime boundary must drop this select-only option.
    const choice = ui.mode.showExtensionConfirm("Confirm", "Fixture only", { vinciReviewContext: true });
    await ui.waitForText("Fixture only");
    expect(ui.mode.extensionSelector.review).toBeUndefined();
    ui.sendKeys("\x1b");
    expect(await choice).toBe(false);
  });
});
