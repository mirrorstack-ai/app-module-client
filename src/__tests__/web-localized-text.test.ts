import assert from "node:assert/strict";
import { test } from "vitest";

import { resolveLocalizedText } from "../web/localized-text.js";

test("literal localized text is preserved without trimming", () => {
  assert.equal(resolveLocalizedText("  Authored label  ", "en-US"), "  Authored label  ");
  assert.equal(resolveLocalizedText("   ", "en-US"), "");
  assert.equal(resolveLocalizedText(null, "en-US"), "");
});

test("localized text follows exact, primary-language, and fallback priority", () => {
  const text = {
    "zh-TW": "繁體",
    "en-US": "English",
    "fr-FR": "Français",
  };

  assert.equal(resolveLocalizedText(text, "ZH-tw"), "繁體");
  assert.equal(resolveLocalizedText(text, "en-GB"), "English");
  assert.equal(resolveLocalizedText(text, "de-DE"), "English");
  assert.equal(resolveLocalizedText(text, "de-DE", "fr-FR"), "Français");
});

test("localized text skips blank entries and falls back to the first authored value", () => {
  const text = {
    "en-US": "  ",
    "zh-TW": "  保留空白  ",
    "fr-FR": "Français",
  };

  assert.equal(resolveLocalizedText(text, "de-DE"), "  保留空白  ");
  assert.equal(resolveLocalizedText({ "en-US": "\t" }), "");
});
