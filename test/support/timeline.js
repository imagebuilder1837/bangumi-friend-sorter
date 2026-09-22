const assert = require("node:assert/strict");

const fs = require("node:fs");

const path = require("node:path");

const FIXTURE_DIR = path.join(__dirname, "..", "fixtures");

function timelineDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, filename), "utf8");
  const hasTimeline = /id=["']timeline["']/.test(html);
  const hasTimelineTabs = /id=["']timelineTabs["']/.test(html);
  const hasTimelineContent =
    /id=["']tmlContent["'][^>]*>\s*<div id=["']timeline["']/.test(html);
  const item = html.match(
    /<li[^>]*class=["'][^"']*\btml_item\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/,
  );
  const hasItem = item !== null;
  const timestamp = item?.[1].match(
    /<div[^>]*class=["'][^"']*\bpost_actions\b[^"']*["'][^>]*>[\s\S]*?<span[^>]*title=["']([^"']+)["'][^>]*class=["'][^"']*\btitleTip\b[^"']*["'][^>]*>([^<]*)</,
  );
  const timestampNode = timestamp
    ? {
        getAttribute: (name) => (name === "title" ? timestamp[1] : null),
        textContent: timestamp[2],
      }
    : null;
  const itemNode = hasItem
    ? {
        querySelector(selector) {
          assert.equal(selector, ".post_actions .titleTip[title]");
          return timestampNode;
        },
      }
    : null;
  const timelineNode = hasTimeline
    ? {
        querySelector(selector) {
          assert.equal(selector, ".tml_item");
          return itemNode;
        },
        textContent: hasItem ? "动态内容" : "",
      }
    : null;

  return {
    querySelector(selector) {
      if (selector === "#timeline") return timelineNode;
      if (selector === "#timelineTabs") return hasTimelineTabs ? {} : null;
      if (selector === "#tmlContent > #timeline") {
        return hasTimelineContent ? timelineNode : null;
      }
      assert.fail(`unexpected selector: ${selector}`);
    },
  };
}

class TimelineFixtureNode {
  constructor({
    attributes = {},
    children = [],
    textContent = "",
    selectors = {},
  } = {}) {
    this.attributes = attributes;
    this.children = children;
    this.textContent = textContent;
    this.selectors = selectors;
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  querySelector(selector) {
    return this.selectors[selector]?.[0] ?? null;
  }

  querySelectorAll(selector) {
    return this.selectors[selector] ?? [];
  }
}

function fixtureAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([\w-]+)=["']([^"']*)["']/g)].map(
      ([, name, value]) => [name, value.replaceAll("&amp;", "&")],
    ),
  );
}

function timelineFixtureAnchorNodes(source) {
  return [...source.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map(
    ([, attributes, textContent]) =>
      new TimelineFixtureNode({
        attributes: fixtureAttributes(attributes),
        textContent: textContent.replace(/<[^>]+>/g, "").trim(),
      }),
  );
}

function tietieDocumentFromFixture(filename) {
  const html = fs.readFileSync(path.join(FIXTURE_DIR, filename), "utf8");
  const itemMatches = [
    ...html.matchAll(/<li\b([^>]*\btml_item\b[^>]*)>([\s\S]*?)<\/li>/g),
  ];
  const itemNodes = itemMatches.map(([, attributes, body]) => {
    const anchors = timelineFixtureAnchorNodes(body);
    const subjectAnchors = anchors.filter((anchor) =>
      anchor.getAttribute("href")?.includes("/subject/"),
    );
    const statusAnchors = anchors.filter((anchor) =>
      anchor.getAttribute("href")?.includes("/timeline/status/"),
    );
    const reactionGridTag = body.match(
      /<[^>]*class=["'][^"']*\blikes_grid\b[^"']*["'][^>]*>/,
    );
    const reactionGrid = reactionGridTag
      ? new TimelineFixtureNode({
          attributes: fixtureAttributes(reactionGridTag[0]),
        })
      : null;
    const collectionInfo = /class=["'][^"']*\bcollectInfo\b[^"']*["']/.test(
      body,
    )
      ? new TimelineFixtureNode()
      : null;
    const infoFull = /class=["'][^"']*\binfo_full\b[^"']*["']/.test(body)
      ? new TimelineFixtureNode()
      : null;
    return new TimelineFixtureNode({
      attributes: fixtureAttributes(attributes),
      selectors: {
        'a[data-subject-id][href*="/subject/"]': subjectAnchors.filter(
          (anchor) => anchor.getAttribute("data-subject-id"),
        ),
        'a[href*="/subject/"]': subjectAnchors,
        'a.tml_comment[href*="/timeline/status/"]': statusAnchors.filter(
          (anchor) => anchor.getAttribute("class")?.includes("tml_comment"),
        ),
        ".likes_grid[id]": reactionGrid ? [reactionGrid] : [],
        ".collectInfo": collectionInfo ? [collectionInfo] : [],
        ".info_full": infoFull ? [infoFull] : [],
      },
    });
  });

  const timeline = new TimelineFixtureNode({
    textContent: itemNodes.length > 0 ? "动态" : "",
    selectors: { ".tml_item": itemNodes },
  });
  const pagerSource = html.match(
    /<div id=["']tmlPager["']>([\s\S]*?)<\/div>\s*<\/div>/,
  );
  const pagerAnchors = pagerSource
    ? timelineFixtureAnchorNodes(pagerSource[1])
    : [];
  const pager = pagerSource
    ? new TimelineFixtureNode({ selectors: { "a[href]": pagerAnchors } })
    : null;
  if (pager) timeline.selectors["#tmlPager"] = [pager];

  const scripts = [
    ...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g),
  ].map(([, textContent]) => new TimelineFixtureNode({ textContent }));
  const tabs = /id=["']timelineTabs["']/.test(html)
    ? new TimelineFixtureNode()
    : null;

  return {
    querySelector(selector) {
      if (selector === "#timelineTabs") return tabs;
      if (selector === "#timeline") return timeline;
      if (selector === "#tmlContent > #timeline") return tabs ? timeline : null;
      if (selector === "#tmlPager") return pager;
      assert.fail(`unexpected selector: ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === "script") return scripts;
      assert.fail(`unexpected selectorAll: ${selector}`);
    },
  };
}

module.exports = { timelineDocumentFromFixture, TimelineFixtureNode, fixtureAttributes, timelineFixtureAnchorNodes, tietieDocumentFromFixture };
