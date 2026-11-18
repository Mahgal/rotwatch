/* Local smoke test for the RotWatch check handler.
 * Runs the same module that deploys as the Worker, under Node 20+.
 * Usage: node worker/smoke-test.mjs
 */
import handler from "./check.js";

async function run(label, target) {
  const request = new Request("https://localhost/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: target }),
  });
  const response = await handler.fetch(request);
  const data = await response.json();
  console.log("== " + label + " ==");
  console.log("HTTP " + response.status);
  console.log(JSON.stringify(data, null, 1).slice(0, 1200));
}

await run("known good page", "https://example.com/");
await run("known 404 page", "https://example.com/this-page-does-not-exist-rotwatch");
await run("private address, must be refused", "http://127.0.0.1:8080/");
await run("bad input, must be refused", "not a url");
