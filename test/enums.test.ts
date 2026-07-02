import { describe, it, expect } from "vitest";
import {
  className,
  damageName,
  CLASS_NAME_TO_TYPE,
  DAMAGE_NAME_TO_TYPE,
} from "../src/enums.js";

describe("enums", () => {
  it("maps class types to names", () => {
    expect(className(0)).toBe("Titan");
    expect(className(2)).toBe("Warlock");
    expect(className(undefined)).toBe("?");
  });

  it("maps damage types to names", () => {
    expect(damageName(3)).toBe("Solar");
    expect(damageName(7)).toBe("Strand");
  });

  it("round-trips name -> type -> name", () => {
    expect(className(CLASS_NAME_TO_TYPE["hunter"])).toBe("Hunter");
    expect(damageName(DAMAGE_NAME_TO_TYPE["void"])).toBe("Void");
  });
});
