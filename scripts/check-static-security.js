import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

assert.match(indexHtml, /http-equiv="Content-Security-Policy"/i, "index.html must declare a CSP");
assert.doesNotMatch(indexHtml, /moment@2\.29\.1/, "the vulnerable Moment.js version must not return");

const externalScriptTags = (indexHtml.match(/<script\b[\s\S]*?<\/script>/gi) || [])
  .filter((tag) => /src="https:\/\//i.test(tag));
assert.equal(externalScriptTags.length, 5, "all five expected external scripts must be present");

const analyticsTags = externalScriptTags.filter((tag) =>
  /src="https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js"/i.test(tag)
);
assert.equal(analyticsTags.length, 1, "the Cloudflare Web Analytics beacon must be present once");
assert.match(analyticsTags[0], /type="module"/i, "the analytics beacon must be an ES module");
assert.match(
  analyticsTags[0],
  /data-cf-beacon='\{"token":"[a-f0-9]{32}"\}'/i,
  "the analytics beacon must include a valid site token"
);

const libraryScriptTags = externalScriptTags.filter((tag) => !analyticsTags.includes(tag));
assert.equal(libraryScriptTags.length, 4, "all four browser libraries must be present");
for (const tag of libraryScriptTags) {
  assert.match(tag, /integrity="sha384-[^"]+"/i, "every external script must have SHA-384 SRI");
  assert.match(tag, /crossorigin="anonymous"/i, "every external script must use anonymous CORS");
}

assert.match(
  indexHtml,
  /script-src[^;"]*https:\/\/static\.cloudflareinsights\.com\/beacon\.min\.js/i,
  "the CSP must allow the Cloudflare analytics script"
);
assert.match(
  indexHtml,
  /connect-src[^;"]*https:\/\/cloudflareinsights\.com/i,
  "the CSP must allow the Cloudflare analytics endpoint"
);

assert.doesNotMatch(appSource, /\bonerror\s*=/i, "inline event handlers are blocked by the CSP");
assert.doesNotMatch(
  appSource,
  /src="\$\{(?:avatar|iconUrl|state\.assetIconCache)/,
  "API-derived image URLs must be assigned through DOM properties"
);
assert.match(appSource, /function normalizeImageUrl\(/, "image URLs must pass through the shared normalizer");

console.log("Static browser security checks passed.");
