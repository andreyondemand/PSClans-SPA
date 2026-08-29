import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

assert.match(indexHtml, /http-equiv="Content-Security-Policy"/i, "index.html must declare a CSP");
assert.doesNotMatch(indexHtml, /moment@2\.29\.1/, "the vulnerable Moment.js version must not return");

const externalScriptTags = (indexHtml.match(/<script\b[\s\S]*?<\/script>/gi) || [])
  .filter((tag) => /src="https:\/\//i.test(tag));
assert.equal(externalScriptTags.length, 4, "all four expected browser libraries must be present");
for (const tag of externalScriptTags) {
  assert.match(tag, /integrity="sha384-[^"]+"/i, "every external script must have SHA-384 SRI");
  assert.match(tag, /crossorigin="anonymous"/i, "every external script must use anonymous CORS");
}

assert.doesNotMatch(appSource, /\bonerror\s*=/i, "inline event handlers are blocked by the CSP");
assert.doesNotMatch(
  appSource,
  /src="\$\{(?:avatar|iconUrl|state\.assetIconCache)/,
  "API-derived image URLs must be assigned through DOM properties"
);
assert.match(appSource, /function normalizeImageUrl\(/, "image URLs must pass through the shared normalizer");

console.log("Static browser security checks passed.");
