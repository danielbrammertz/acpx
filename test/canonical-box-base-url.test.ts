import assert from "node:assert/strict";
import test from "node:test";
import {
  acpxUiBaseUrlFrom,
  canonicalBaseUrlFromHostmapCache,
  deriveBoxBaseUrlFrom,
  envValueFromEnviron,
  parseNamespaceFromResolvConf,
  unresolvedBaseUrlMessage,
} from "../src/acp/auth-env.js";

// PROD-2 (brick e437db49) + brick f29ba473 — the canonical-host ladder.
//
// Fixtures below are konsiq's and devbox's REAL file contents, measured read-only
// on 2026-08-20 against deployed acpx ff1cc2e7 (konsiq) / 9566e7c (devbox). Two
// strings must be kept apart everywhere in this file:
//
//   https://acpx.konsiq.nativai.de     ← the structural ALIAS. Servable, NOT canonical.
//   https://acpx.devbox.konsiq.de      ← the CANONICAL host. What rungs 2 and 3 give.
//
// ⚠️ DO NOT rewrite these as "assert the result is a valid acpx URL". Both strings
// are valid acpx URLs; the whole defect is which one comes out. Every assertion
// here names the exact expected string on purpose.
//
// PROD-2 demoted the alias to a last-resort rung; f29ba473 DELETED it, along with
// the `https://acpx.devbox.nativai.de` literal below it. The ladder is now
// env → PID-1 → hostmap cache → UNDEFINED (+ one warning), and this file's job is to
// keep it that way: the alias string must never again be producible from the box's
// own files, and the miss must stay a miss rather than becoming a throw — a throw
// would block every spawn on a host where no rung resolves.

const KONSIQ_RESOLV_CONF =
  "search dev-konsiq.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.109.0.10\noptions ndots:5\n";
const DEVBOX_RESOLV_CONF =
  "search dev-devbox.svc.cluster.local svc.cluster.local cluster.local\nnameserver 10.109.0.10\noptions ndots:5\n";

const KONSIQ_PID1_ENVIRON =
  "PATH=/usr/local/bin:/usr/bin\0ACPX_UI_BASE_URL=https://acpx.devbox.konsiq.de\0HOME=/home/node\0";

// The live cache, trimmed to the entries that matter: dev-konsiq contributes BOTH a
// canonical (`source: "discovered"`) and an alias entry, which is exactly the
// discrimination rung 3 has to make.
const HOSTMAP_CACHE = JSON.stringify({
  generatedAt: 1786978229738,
  entries: [
    {
      host: "acpx.konsiq.nativai.de",
      namespace: "dev-konsiq",
      endpoint: "http://dev-server.dev-konsiq.svc.cluster.local:3456",
      source: "alias",
    },
    {
      host: "acpx.devbox.konsiq.de",
      namespace: "dev-konsiq",
      endpoint: "http://dev-server.dev-konsiq.svc.cluster.local:3456",
      source: "discovered",
    },
    {
      host: "acpx.devbox.nativai.de",
      namespace: "dev-devbox",
      endpoint: "http://dev-server.dev-devbox.svc.cluster.local:3456",
      source: "discovered",
    },
  ],
  misses: {},
});

const ALIAS = "https://acpx.konsiq.nativai.de";
const CANONICAL = "https://acpx.devbox.konsiq.de";

// ---------------------------------------------------------------------------
// The transition the brick exists for
// ---------------------------------------------------------------------------

test("PROD-2 transition: konsiq's real inputs yield the CANONICAL host", () => {
  // The full ladder over the box's real files.
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: KONSIQ_PID1_ENVIRON,
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    CANONICAL,
  );
});

test("PROD-2 control: devbox is unchanged by the ladder — every rung agrees", () => {
  const devboxHost = "https://acpx.devbox.nativai.de";
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: `ACPX_UI_BASE_URL=${devboxHost}\0`,
      namespaceFile: "dev-devbox\n",
      resolvConf: DEVBOX_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    devboxHost,
  );
});

// ---------------------------------------------------------------------------
// Rung ordering — each rung must beat the one below it, proven by making them
// disagree. A fixture where two rungs agree cannot detect a swapped order.
// ---------------------------------------------------------------------------

test("PROD-2 ordering: /proc/1/environ (rung 2) beats the hostmap cache and resolv.conf", () => {
  assert.equal(
    deriveBoxBaseUrlFrom({
      pid1Environ: "ACPX_UI_BASE_URL=https://acpx.pid-one-wins.example\0",
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    "https://acpx.pid-one-wins.example",
  );
});

test("PROD-2 ordering: the hostmap cache (rung 3) is what resolv.conf's namespace keys into", () => {
  assert.equal(
    deriveBoxBaseUrlFrom({
      namespaceFile: "dev-konsiq\n",
      resolvConf: KONSIQ_RESOLV_CONF,
      hostmapCache: HOSTMAP_CACHE,
    }),
    CANONICAL,
  );
});

test("PROD-2 ordering: resolv.conf supplies the namespace when the service-account file is absent", () => {
  // Rung 3 still fires — the namespace is recoverable from resolv.conf alone, so
  // dropping the namespace file must not silently demote the box to its alias.
  assert.equal(
    deriveBoxBaseUrlFrom({ resolvConf: KONSIQ_RESOLV_CONF, hostmapCache: HOSTMAP_CACHE }),
    CANONICAL,
  );
});

// ---------------------------------------------------------------------------
// Fall-through: a missing or unusable input must demote by one rung, never throw.
// This resolver runs on EVERY spawn.
// ---------------------------------------------------------------------------

test("PROD-2 fall-through: no usable input at all → undefined (the caller then omits the URL)", () => {
  assert.equal(deriveBoxBaseUrlFrom({}), undefined);
  assert.equal(deriveBoxBaseUrlFrom({ resolvConf: "nameserver 1.1.1.1\n" }), undefined);
});

test("PROD-2 fall-through: a missing / malformed / stale hostmap cache is a MISS, never a throw", () => {
  const withoutCache = { namespaceFile: "dev-konsiq\n", resolvConf: KONSIQ_RESOLV_CONF };
  // Absent file.
  assert.equal(deriveBoxBaseUrlFrom(withoutCache), undefined);
  // Truncated mid-write / not JSON at all.
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: '{"entries":[' }), undefined);
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "" }), undefined);
  // Valid JSON, wrong shape.
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "null" }), undefined);
  assert.equal(deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: "[]" }), undefined);
  assert.equal(
    deriveBoxBaseUrlFrom({ ...withoutCache, hostmapCache: '{"entries":"nope"}' }),
    undefined,
  );
  // Stale: a real cache that predates this box joining the fleet.
  assert.equal(
    deriveBoxBaseUrlFrom({
      ...withoutCache,
      hostmapCache: JSON.stringify({ entries: [{ host: "a.b", namespace: "dev-other" }] }),
    }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// f29ba473 — the deleted rungs. These are the tests that go RED if anyone
// re-introduces a constructed hostname or a literal default.
// ---------------------------------------------------------------------------

test("ladder: resolv.conf alone yields NOTHING — it supplies a namespace, not a hostname", () => {
  // The exact inputs the deleted rung 4 turned into `https://acpx.<box>.nativai.de`:
  // a cluster resolv.conf and nothing else. Re-add any rule of that shape — for
  // konsiq or for devbox — and this goes red on the first assertion it produces.
  for (const resolvConf of [KONSIQ_RESOLV_CONF, DEVBOX_RESOLV_CONF]) {
    for (const sources of [
      { resolvConf },
      { resolvConf, namespaceFile: "dev-konsiq\n" },
      // A cache present but useless: the namespace is known, the host is not.
      { resolvConf, hostmapCache: '{"entries":[]}' },
    ]) {
      assert.equal(deriveBoxBaseUrlFrom(sources), undefined);
      assert.notEqual(deriveBoxBaseUrlFrom(sources), ALIAS);
    }
  }
  // And the namespace itself is still read — the rung was removed, not the parser.
  assert.equal(parseNamespaceFromResolvConf(KONSIQ_RESOLV_CONF), "dev-konsiq");
});

test("ladder: a resolv.conf-only box yields UNDEFINED instead of minting a host", () => {
  // Not a throw: a throw would block every spawn on a host where no rung resolves,
  // and the deleted literal's own comment ("non-cluster / unknown namespace") records
  // that its authors expected such a host to exist. Undefined makes each caller
  // decide, under the typechecker, between omitting the URL and inventing one.
  assert.equal(acpxUiBaseUrlFrom({}, { resolvConf: KONSIQ_RESOLV_CONF }), undefined);
  // Same for the deleted literal default: no inputs at all is undefined too.
  assert.equal(acpxUiBaseUrlFrom({}, {}), undefined);
});

test("ladder: the unresolved-warning names the knob and hands back NO hostname", () => {
  const message = unresolvedBaseUrlMessage("/home/agent/.acpx/hostmap-cache.json");
  // Actionable: it names the knob to set and the paths it tried.
  assert.match(message, /ACPX_UI_BASE_URL/);
  assert.match(message, /\/proc\/1\/environ/);
  assert.match(message, /hostmap-cache\.json/);
  // ⚠️ And it must not hand the reader a hostname to paste. The whole point of the
  // degraded path is that acpx does not know one; a "did you mean" in the diagnostic
  // would be the fabrication coming back in through the warning text.
  assert.doesNotMatch(message, /https:\/\/acpx\./);
  assert.doesNotMatch(message, /nativai\.de/);
});

test("ladder: rung 1 wins, is trimmed, and is the only thing that saves an otherwise-empty box", () => {
  assert.equal(
    acpxUiBaseUrlFrom({ ACPX_UI_BASE_URL: "https://acpx.devbox.konsiq.de/" }, {}),
    CANONICAL,
  );
  // Blank env is not a value — it falls through to the rest of the ladder…
  assert.equal(
    acpxUiBaseUrlFrom({ ACPX_UI_BASE_URL: "   " }, { pid1Environ: KONSIQ_PID1_ENVIRON }),
    CANONICAL,
  );
  // …and when the rest of the ladder misses too, it reports nothing rather than
  // defaulting to somebody else's box.
  assert.equal(acpxUiBaseUrlFrom({ ACPX_UI_BASE_URL: "   " }, {}), undefined);
});

// ---------------------------------------------------------------------------
// Rung 3's discrimination — the alias/canonical test is the whole point
// ---------------------------------------------------------------------------

test("canonicalBaseUrlFromHostmapCache: skips the alias entry and returns the canonical one", () => {
  assert.equal(canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-konsiq"), CANONICAL);
  assert.equal(
    canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-devbox"),
    "https://acpx.devbox.nativai.de",
  );
});

test("canonicalBaseUrlFromHostmapCache: an alias-ONLY namespace is a miss, not a fallback to the alias", () => {
  // Rung 4 already produces the alias. If rung 3 returned it too, a box that never
  // reported a canonical host would look like one that did.
  const aliasOnly = JSON.stringify({
    entries: [{ host: "acpx.konsiq.nativai.de", namespace: "dev-konsiq", source: "alias" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(aliasOnly, "dev-konsiq"), undefined);
});

test("canonicalBaseUrlFromHostmapCache: matches acpx-ui's `source !== alias` test, so a sourceless entry counts", () => {
  const noSource = JSON.stringify({
    entries: [{ host: "acpx.devbox.konsiq.de", namespace: "dev-konsiq" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(noSource, "dev-konsiq"), CANONICAL);
});

test("canonicalBaseUrlFromHostmapCache: unknown namespace and unusable entries are misses", () => {
  assert.equal(canonicalBaseUrlFromHostmapCache(HOSTMAP_CACHE, "dev-nosuchbox"), undefined);
  const junk = JSON.stringify({
    entries: [null, 7, "x", { namespace: "dev-konsiq" }, { host: "   ", namespace: "dev-konsiq" }],
  });
  assert.equal(canonicalBaseUrlFromHostmapCache(junk, "dev-konsiq"), undefined);
});

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

test("envValueFromEnviron: reads a NUL-separated KEY=value block", () => {
  assert.equal(
    envValueFromEnviron(KONSIQ_PID1_ENVIRON, "ACPX_UI_BASE_URL"),
    "https://acpx.devbox.konsiq.de",
  );
  assert.equal(envValueFromEnviron(KONSIQ_PID1_ENVIRON, "HOME"), "/home/node");
  assert.equal(envValueFromEnviron(KONSIQ_PID1_ENVIRON, "NOT_SET"), undefined);
  // Prefix collisions must not match, and an empty value is a miss not an empty string.
  assert.equal(envValueFromEnviron("ACPX_UI_BASE_URL_EXTRA=x\0", "ACPX_UI_BASE_URL"), undefined);
  assert.equal(envValueFromEnviron("ACPX_UI_BASE_URL=   \0", "ACPX_UI_BASE_URL"), undefined);
  assert.equal(envValueFromEnviron("", "ACPX_UI_BASE_URL"), undefined);
});

test("parseNamespaceFromResolvConf: derives dev-<box>, undefined off-cluster", () => {
  assert.equal(parseNamespaceFromResolvConf(KONSIQ_RESOLV_CONF), "dev-konsiq");
  assert.equal(parseNamespaceFromResolvConf(DEVBOX_RESOLV_CONF), "dev-devbox");
  assert.equal(parseNamespaceFromResolvConf("search example.com lan\n"), undefined);
  assert.equal(parseNamespaceFromResolvConf(""), undefined);
});
