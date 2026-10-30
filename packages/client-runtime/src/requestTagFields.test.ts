import { describe, expect, it } from "vite-plus/test";

import {
  requestTagFieldRows,
  requestTagFieldValues,
  requestTagsFromFields,
  sameRequestTags,
} from "./requestTagFields.ts";

describe("request tag fields", () => {
  it("puts each tag in its field, with bare tags under Project as the server sends them", () => {
    expect(
      requestTagFieldValues([
        "jira:PROJ-1",
        "jira:PROJ-2",
        "project:passport",
        "billing",
        "env:dev",
        "tool:opencode",
        "team:platform",
      ]),
    ).toEqual({
      jira: "PROJ-1, PROJ-2",
      project: "passport, billing",
      env: "dev",
      tool: "opencode",
      other: "team:platform",
    });
  });

  it("adds each category once and drops blank fields", () => {
    expect(
      requestTagsFromFields([], {
        jira: " PROJ-1, jira:PROJ-2 ,",
        project: "",
        env: "dev",
        tool: "  ",
        other: "team:platform",
      }),
    ).toEqual({
      tags: ["jira:PROJ-1", "jira:PROJ-2", "env:dev", "team:platform"],
      error: null,
    });
  });

  it("keeps existing tags exactly when another value changes", () => {
    const bare = "x".repeat(64);
    const original = ["project:project:billing", "project: spaced", bare, "env:dev"];
    const values = requestTagFieldValues(original);
    expect(
      requestTagsFromFields(original, {
        ...values,
        jira: "PROJ-1",
        project: `${values.project}, new`,
      }),
    ).toEqual({
      tags: ["jira:PROJ-1", ...original.slice(0, 3), "project:new", "env:dev"],
      error: null,
    });
  });

  it("reports values over the limits and does not cut them", () => {
    const empty = requestTagFieldValues([]);
    const tooLong = requestTagsFromFields([], { ...empty, project: "x".repeat(60) });
    expect(tooLong.tags).toEqual([`project:${"x".repeat(60)}`]);
    expect(tooLong.error).toContain("64");
    const tooMany = Array.from({ length: 17 }, (_, index) => `PROJ-${index}`).join(",");
    expect(requestTagsFromFields([], { ...empty, jira: tooMany }).error).toContain("16");
  });

  it("shows the tool tag the server sends when the field stays blank", () => {
    const toolPlaceholder = (...input: Parameters<typeof requestTagFieldRows>) =>
      requestTagFieldRows(...input).find(({ key }) => key === "tool")?.placeholder;
    const repo = { mode: "repo", custom: "" } as const;
    expect(toolPlaceholder("claudeAgent", repo)).toBe("T3-Code/claude");
    expect(toolPlaceholder("opencode", { mode: "custom", custom: "acme" })).toBe(
      "T3-Code/opencode",
    );
    expect(toolPlaceholder("codex", { mode: "custom", custom: "acme, tool:company" })).toBe(
      "company",
    );
    expect(toolPlaceholder("claudeAgent", { mode: "off", custom: "" })).toBe("None");
    expect(toolPlaceholder(undefined, repo)).toBe("Automatic");
  });

  it("ignores order when it compares tags", () => {
    expect(sameRequestTags(["billing", "env:dev"], ["env:dev", "billing"])).toBe(true);
    expect(sameRequestTags(["billing"], ["project:billing"])).toBe(false);
  });
});
