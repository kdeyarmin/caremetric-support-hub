// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { ContentItem } from "../domain";
import { HelpArticlePage } from "./HelpArticle";
import { helpArticlePath, isPublicHelpPath } from "./helpArticles";

afterEach(cleanup);

const article = (over: Partial<ContentItem> = {}): ContentItem => ({
  id: "r1", contentKey: "pennsylvania-fire-drills", kind: "article", title: "Fire drill requirements", summary: "Monthly drills and the record.",
  body: "**In short:** hold a drill monthly.\n\n## Records\n\n- date\n- time\n\nSee [the rule](https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html) and [bad](javascript:alert(1)).\n\n<img src=x onerror=alert(1)>",
  status: "published", accessLevel: "public", productIds: ["p1"], audience: ["all"], locale: "en-US", revision: 1, sourceSystem: "support_hub", routePattern: null, ...over,
});
const at = (path: string, content: ContentItem[]) => render(
  <MemoryRouter initialEntries={[path]}><Routes><Route path="/help/articles/:key" element={<HelpArticlePage content={content} />} /></Routes></MemoryRouter>,
);

describe("a help article at its own address", () => {
  it("shows the article's title, summary and Markdown, and names the page", () => {
    const { container } = at("/help/articles/pennsylvania-fire-drills", [article()]);
    expect(screen.getByRole("heading", { level: 1, name: "Fire drill requirements" })).toBeTruthy();
    expect(screen.getByText("Monthly drills and the record.")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Records" })).toBeTruthy();
    expect(container.querySelectorAll(".help-article-body li")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "the rule" }).getAttribute("href")).toBe("https://www.pacodeandbulletin.gov/secure/pacode/data/055/chapter2600/s2600.132.html");
    expect(screen.getByRole("link", { name: "Help center" }).getAttribute("href")).toBe("/help");
    expect(document.title).toBe("Fire drill requirements | CareMetric Help Center");
  });

  it("never turns article text into markup or an unsafe link", () => {
    const { container } = at("/help/articles/pennsylvania-fire-drills", [article()]);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    expect([...container.querySelectorAll("a")].every(link => !/^javascript:/i.test(link.getAttribute("href") ?? ""))).toBe(true);
  });

  it("says so when there is no such published article", () => {
    for (const content of [[], [article({ status: "draft" })], [article({ kind: "course" })], [article({ contentKey: "another" })]]) {
      at("/help/articles/pennsylvania-fire-drills", content);
      expect(screen.getByRole("heading", { level: 1, name: "This article is not available" })).toBeTruthy();
      cleanup();
    }
  });

  it("knows the help center's public addresses", () => {
    expect(helpArticlePath("support.protect-patient-information")).toBe("/help/articles/support.protect-patient-information");
    for (const path of ["/help", "/learn", "/help/articles/x", "/help/articles/x/"]) expect(isPublicHelpPath(path), path).toBe(true);
    for (const path of ["/", "/help/", "/help/articles", "/help/articles/", "/help/articles/x/y", "/cases", "/learn/courses/1"]) expect(isPublicHelpPath(path), path).toBe(false);
  });
});
