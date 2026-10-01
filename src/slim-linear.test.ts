import { describe, expect, test } from "bun:test";
import { LINEAR_DESCRIPTION_CAP, slimLinearPayload } from "./server";
const pm = (n: number) => ({ type: "doc", content: Array.from({ length: n }, (_, i) => ({ type: "paragraph", content: [{ type: "text", text: `line ${i} `.repeat(20) }] })) });
describe("slimLinearPayload", () => {
  test("Issue: descriptionData dropped, description excerpted with a fetch pointer, everything a lane reads kept", () => {
    const desc = "D".repeat(6000);
    const body = { action: "create", type: "Issue", url: "https://linear.app/fabrica/issue/ENG-4509", actor: { id: "a", name: "Brioche" },
      data: { id: "b095a3e0-436e-4380-939d-03b15b66ac76", identifier: "ENG-4509", title: "paper route", description: desc, descriptionData: JSON.stringify(pm(200)),
        state: { id: "s", name: "In Progress", type: "started" }, labels: [{ id: "l", name: "Urgent" }], assignee: { id: "u", name: "eng" }, priority: 1, url: "https://linear.app/x" } };
    const before = JSON.stringify(body);
    const out = slimLinearPayload(body) as any;
    expect(out.data.descriptionData).toBeUndefined();
    expect(out.data.description.startsWith("D".repeat(LINEAR_DESCRIPTION_CAP))).toBe(true);
    expect(out.data.description).toContain("5800 more chars trimmed by the Wire gateway — Linear get_issue ENG-4509 for the full text");
    expect(out.data.identifier).toBe("ENG-4509"); expect(out.data.title).toBe("paper route"); expect(out.data.state.name).toBe("In Progress");
    expect(out.data.labels).toEqual([{ id: "l", name: "Urgent" }]); expect(out.data.id).toBe("b095a3e0-436e-4380-939d-03b15b66ac76");
    expect(out.type).toBe("Issue"); expect(out.action).toBe("create"); expect(out.url).toBe(body.url);
    expect(JSON.stringify(body)).toBe(before);                       // input untouched: filters/dedup saw the original
    expect(JSON.stringify(out).length).toBeLessThan(before.length / 10);
  });
  test("a short description passes unchanged; updatedFrom is slimmed the same way", () => {
    const body = { action: "update", type: "Issue", data: { id: "i", identifier: "ENG-1", description: "short", descriptionData: "{}" },
      updatedFrom: { description: "O".repeat(900), descriptionData: JSON.stringify(pm(50)), updatedAt: "t" } };
    const out = slimLinearPayload(body) as any;
    expect(out.data.description).toBe("short"); expect(out.data.descriptionData).toBeUndefined();
    expect(out.updatedFrom.descriptionData).toBeUndefined(); expect(out.updatedFrom.updatedAt).toBe("t");
    expect(out.updatedFrom.description).toContain("700 more chars trimmed by the Wire gateway — Linear get_issue ENG-1");
  });
  test("Comment body kept whole; Attachment passes through; non-objects pass through", () => {
    const comment = { action: "create", type: "Comment", data: { id: "c", body: "B".repeat(3000), issue: { id: "i", identifier: "ENG-2", title: "t" } } };
    expect((slimLinearPayload(comment) as any).data.body).toBe("B".repeat(3000));
    const att = { action: "update", type: "Attachment", data: { id: "a", issueId: "45dee958", title: "ENG-4500 PR", url: "https://github.com/x/pull/1" } };
    expect(slimLinearPayload(att)).toEqual(att);
    expect(slimLinearPayload("not json")).toBe("not json"); expect(slimLinearPayload(null)).toBe(null); expect(slimLinearPayload([1])).toEqual([1]);
  });
  test("no identifier: the pointer names the issue id instead of an empty ref", () => {
    const out = slimLinearPayload({ type: "Issue", data: { id: "uuid-1", description: "x".repeat(300) } }) as any;
    expect(out.data.description).toContain("Linear get_issue uuid-1 for the full text");
  });
});
