# Real-application checks

Run on a Windows PC after building TEST installers (`BUILD_CHANNEL=test`). They start the TEST server
with a throw-away database and drive the real Admin / Kassa / Oshxona / TV windows through Chromium's
remote-debugging port. They never touch the installed production application.

- `real-apps-e2e.mjs` — server + Admin + Kassa + Oshxona + TV: automatic discovery, a real order, kitchen
  accept/ready/reject, TV queue, report files, stock alert, network status, display account.
- `lan-shell-e2e.mjs <KassaTest.exe>` — discovery, reconnect after an address change, fake-server rejection, choice of
  several servers.
- `lan-discovery-unit.cjs` — signed discovery protocol on this computer.

Edit the paths at the top (`root`, the `release-*` folders) to match your builds.
