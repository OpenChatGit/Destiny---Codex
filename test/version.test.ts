import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SEMVER, DATE_VERSION, FULL_VERSION } from "../src/version.js";

const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
);

describe("version consistency", () => {
  it("package.json version matches src/version.ts SEMVER", () => {
    expect(pkg.version).toBe(SEMVER);
  });

  it("DATE_VERSION is DD.MM.YYYY", () => {
    expect(DATE_VERSION).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
  });

  it("FULL_VERSION combines both", () => {
    expect(FULL_VERSION).toBe(`${SEMVER} (${DATE_VERSION})`);
  });
});
