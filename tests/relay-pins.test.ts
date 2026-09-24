import { describe, expect, it } from "vitest";
import { mismatches } from "../relay/check-pins.mjs";

describe("relay pins", () => {
  it("passes when every copy is the home blob", () => {
    expect(
      mismatches([
        {
          home: { repo: "cursor-relay", path: "hold.mjs", sha: "abc" },
          copies: [{ repo: "zeuge", path: "relay/hold.mjs", sha: "abc" }],
        },
      ]),
    ).toEqual([]);
  });

  it("names the repo that drifted", () => {
    const found = mismatches([
      {
        home: { repo: "cursor-relay", path: "hold.mjs", sha: "abc" },
        copies: [{ repo: "genesis-web", path: "relay/hold.mjs", sha: "def" }],
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("genesis-web relay/hold.mjs is def");
    expect(found[0]).toContain("cursor-relay hold.mjs is abc");
  });
});
