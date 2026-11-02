/**
 * Static shell invariants.
 *
 * These are deliberately cheap string checks over the shipped HTML/CSS because
 * the failure they guard against is invisible to the DOM tests: overlays such as
 * `.palette`, `.modal-root` and `.drawer-root` declare `display: flex/grid`,
 * which beats the user-agent `[hidden] { display: none }` rule. When that
 * happens every overlay paints on top of the app at boot — three stacked dark
 * scrims plus a blurred palette — and the product looks like a blank page while
 * the JS and the API are perfectly healthy.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const web = join(import.meta.dirname, "..", "web");
const css = readFileSync(join(web, "styles.css"), "utf8");
const html = readFileSync(join(web, "index.html"), "utf8");
const app = readFileSync(join(web, "app.js"), "utf8");

test("the hidden attribute wins over author display rules", () => {
  const rules = [...css.matchAll(/\[hidden\]\s*\{([^}]*)\}/g)].map((match) => match[1]);
  assert.ok(rules.length > 0, "styles.css must contain a [hidden] rule");
  const rule = rules.at(-1);
  assert.match(rule, /display\s*:\s*none/, "[hidden] must set display: none");
  assert.match(rule, /!important/, "[hidden] must win over .palette/.modal-root/.drawer-root display rules");
});

test("overlays are hidden in the markup they ship with", () => {
  for (const id of ["palette", "modal-root", "drawer-root"]) {
    const tag = html.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`))?.[0];
    assert.ok(tag, `#${id} must exist in index.html`);
    assert.match(tag, /\bhidden\b/, `#${id} must ship hidden so first paint is the app, not a scrim`);
  }
});

test("overlay toggles go through the hidden property", () => {
  // `hidden = true/false` is what the CSS rule above responds to; a class-based
  // toggle would either fight the rule or never hide anything. The modules wrap
  // the lookup in a helper, so accept any occurrence of the id followed shortly
  // by a `.hidden` assignment on the element it resolved to.
  const source = app + readFileSync(join(web, "lib.js"), "utf8");
  for (const id of ["palette", "modal-root", "drawer-root"]) {
    const hits = [...source.matchAll(new RegExp(`["']#?${id}["']`, "g"))];
    assert.ok(hits.length > 0, `#${id} must be referenced by the UI code`);
    const toggles = hits.some((hit) => /\.hidden\s*=/.test(source.slice(hit.index, hit.index + 240)));
    assert.ok(toggles, `#${id} must be toggled with .hidden so the [hidden] rule applies`);
  }
});

test("the shell can announce a boot failure without JavaScript frameworks", () => {
  assert.match(html, /window\.__pcFail/, "index.html must define the boot failure fallback");
  assert.match(html, /__pcBooted/, "index.html must expose the boot flag the app sets");
  assert.match(app, /__pcBooted\s*=\s*true/, "app.js must mark the boot as complete after the first render");
});

test("no remote font or stylesheet import can block first paint", () => {
  assert.doesNotMatch(css, /@import\s+url\(["']?https?:/, "styles.css must not import remote CSS/fonts");
  assert.doesNotMatch(html, /<link[^>]+href="https?:/, "index.html must not link remote assets");
});
