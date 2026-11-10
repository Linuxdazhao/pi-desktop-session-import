import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const zcode = require("../lib/sources/zcode.js");

test("ZCode without a local database is absent, not a failed scan", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "import-absent-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.mock.method(os, "homedir", () => home);
  assert.deepEqual(zcode.scan(), []);
  assert.equal(fs.existsSync(path.join(home, ".zcode")), false);
});

test("ZCode permission errors remain visible instead of appearing absent", (t) => {
  const denied = Object.assign(new Error("Access denied"), { code: "EACCES" });
  t.mock.method(fs, "statSync", () => { throw denied; });
  assert.throws(() => zcode.scan(), (error) => error === denied);
});
