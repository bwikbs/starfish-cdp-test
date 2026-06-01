// Tiny node:http fixture server for the real-Network / cookies / DOMStorage /
// HTTP-origin tests. Serves a keep-alive document plus a couple of subresources,
// and echoes a custom request header (x-agent-echo) into a response header so
// setExtraHTTPHeaders can be verified (ANALYSIS §5.11).

import { createServer } from "node:http";
import { keepAlive } from "./starfish.mjs";

// A small form page: text input (#name), submit button (#go), result area
// (#result). Clicking #go copies the input value into #result. References two
// subresources (a stylesheet and a script) so subresource Network events can be
// observed best-effort.
const PAGE_HTML = `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="/style.css">
  <title>Fixture Form</title>
</head>
<body>
  <h1 id="title" style="color: red;">Agent Task Page</h1>
  <input id="name" type="text" placeholder="enter your name">
  <button id="go">Submit</button>
  <div id="result"></div>
  <script src="/app.js"></script>
  ${keepAlive}
</body>
</html>`;

const STYLE_CSS = `#title { font-weight: bold; }`;

const APP_JS = `document.getElementById('go').addEventListener('click', function () {
  var v = document.getElementById('name').value;
  document.getElementById('result').textContent = 'Hello, ' + v;
  window.submitted = v;
});`;

export async function startFixtureServer() {
  const server = createServer((req, res) => {
    const echo = req.headers["x-agent-echo"];
    if (echo) res.setHeader("x-agent-echo-back", echo);

    if (req.url === "/style.css") {
      res.setHeader("content-type", "text/css");
      res.end(STYLE_CSS);
    } else if (req.url === "/app.js") {
      res.setHeader("content-type", "application/javascript");
      res.end(APP_JS);
    } else {
      res.setHeader("content-type", "text/html");
      res.end(PAGE_HTML);
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    url: `${origin}/page.html`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
