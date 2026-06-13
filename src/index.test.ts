import { describe, expect, it } from "@jest/globals";

import { version } from "./index";

describe("version", () => {
  it("exposes the package version", () => {
    expect(version).toBe("1.0.0");
  });
});
