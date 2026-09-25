// src/tietie-parser.mjs — categorized reaction timeline parsing.

const TIETIE_REACTION_TEMPLATE_IDS = new Set([
  "likes_reaction_menu",
  "likes_reaction_menu_40",
  "likes_reaction_grid_item",
]);
const TIETIE_CATEGORIES = Object.freeze(["say", "subject"]);

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonValueEnd(source, start) {
  const opening = source[start];
  if (opening !== "{" && opening !== "[") return null;

  const closing = opening === "{" ? "}" : "]";
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return null;
}

function parseTietieDataScript(source) {
  const assignment = /\b(?:var|let|const)\s+data_likes_list\s*=\s*/.exec(
    source || "",
  );
  if (!assignment) return null;

  const valueStart = assignment.index + assignment[0].length;
  const valueEnd = jsonValueEnd(source, valueStart);
  if (valueEnd === null) return { invalid: true };
  try {
    const value = JSON.parse(source.slice(valueStart, valueEnd));
    return plainObject(value) ? value : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

function tietieDataFor(document) {
  for (const script of document?.querySelectorAll?.("script") || []) {
    const parsed = parseTietieDataScript(script.textContent);
    if (parsed) return parsed.invalid ? null : parsed;
  }
  return null;
}

function stableReactionUserIdentifier(value) {
  if (typeof value === "string") {
    const identifier = value.trim();
    return identifier || null;
  }
  return Number.isSafeInteger(value) ? String(value) : null;
}

function reactionUsersFor(value) {
  // An empty likes_grid is omitted from data_likes_list and reliably means
  // that the dynamic has no reactions; malformed present data is rejected
  // below instead of being treated as an empty list.
  if (value === undefined) return [];
  const groups = Array.isArray(value)
    ? value
    : plainObject(value)
      ? Object.values(value)
      : null;
  if (!groups) return null;

  // Bangumi permits at most one reaction per user on one dynamic, so a
  // user contributes once even when the response groups several reactions.
  const identifiers = new Set();
  for (const group of groups) {
    if (!plainObject(group) || !Array.isArray(group.users)) return null;
    for (const user of group.users) {
      const identifier = stableReactionUserIdentifier(user?.username);
      if (!identifier) return null;
      identifiers.add(identifier);
    }
  }
  return [...identifiers];
}

function contentKeyForHref(href, baseUrl) {
  if (typeof href !== "string" || !href.trim()) return null;
  try {
    const url = new URL(href, baseUrl || "https://bgm.tv/");
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    return `${pathname}${url.search}`;
  } catch {
    return null;
  }
}

function subjectAnchorFor(item, baseUrl) {
  const anchors = [...(item?.querySelectorAll?.('a[href*="/subject/"]') || [])];
  const normalSubject = (anchor) => {
    const href = anchor?.getAttribute?.("href") || "";
    try {
      const pathname = new URL(href, baseUrl || "https://bgm.tv/").pathname;
      return !/^\/subject\/ep(?:\/|$)/.test(pathname);
    } catch {
      return false;
    }
  };
  return (
    anchors.find(
      (anchor) =>
        anchor.getAttribute?.("data-subject-id") && normalSubject(anchor),
    ) ||
    anchors.find(normalSubject) ||
    anchors[0] ||
    null
  );
}

function contentKeyForTietieItem(item, baseUrl, category) {
  const subjectAnchor = subjectAnchorFor(item, baseUrl);
  const statusAnchor =
    item?.querySelector?.('a.tml_comment[href*="/timeline/status/"]') ||
    item?.querySelector?.('a[href*="/timeline/status/"]');
  const contentAnchor =
    category === "say"
      ? statusAnchor || subjectAnchor
      : subjectAnchor || statusAnchor;
  const href = contentAnchor?.getAttribute?.("href");
  return contentKeyForHref(href, baseUrl);
}

function dynamicIdentifierFor(item) {
  const identifier = item?.getAttribute?.("id")?.trim() || "";
  return /^tml_.+$/.test(identifier) ? identifier : null;
}

function reactionContainerIdentifierFor(item) {
  const identifier =
    item?.querySelector?.(".likes_grid[id]")?.getAttribute?.("id")?.trim() ||
    "";
  return /^likes_grid_.+$/.test(identifier) ? identifier : null;
}

function reactionDataKeyFor(item) {
  const identifier = reactionContainerIdentifierFor(item);
  return identifier?.slice("likes_grid_".length) || null;
}

// A normal collection status can intentionally omit the reaction grid. Its
// content shell and subject link still make it a reliable zero; other
// missing-grid rows remain malformed pages.
function isReactionlessCollectionItem(item, category, contentKey, baseUrl) {
  const collectionSubject = subjectAnchorFor(item, baseUrl);
  const hasCollectionShell =
    item?.querySelector?.(".info_full") ||
    item?.querySelector?.(".collectInfo");
  return Boolean(
    category === "subject" &&
      contentKey &&
      !item?.querySelector?.(".likes_grid") &&
      collectionSubject &&
      hasCollectionShell,
  );
}

function nextTietiePage(document, page, baseUrl) {
  const pager = document?.querySelector?.("#tmlPager");
  const pages = [...(pager?.querySelectorAll?.("a[href]") || [])]
    .map((anchor) => {
      try {
        return Number(
          new URL(anchor.getAttribute("href"), baseUrl).searchParams.get(
            "page",
          ),
        );
      } catch {
        return null;
      }
    })
    .filter((candidate) => Number.isInteger(candidate) && candidate > page);
  return pages.length > 0;
}

function hasActiveTietieCategory(tabs, category, baseUrl) {
  if (!TIETIE_CATEGORIES.includes(category)) return false;
  return [...(tabs?.querySelectorAll?.("a.focus[href]") || [])].some(
    (anchor) => {
      try {
        return (
          new URL(anchor.getAttribute("href"), baseUrl).searchParams.get(
            "type",
          ) === category
        );
      } catch {
        return false;
      }
    },
  );
}

function isTietieReactionTemplate(node) {
  return Boolean(
    node?.nodeType === 1 &&
      node.tagName?.toLowerCase() === "template" &&
      node.getAttribute("type") === "text/template" &&
      TIETIE_REACTION_TEMPLATE_IDS.has(node.id),
  );
}

function isTietieInitializationScript(node) {
  return Boolean(
    node?.nodeType === 1 &&
      node.tagName?.toLowerCase() === "script" &&
      /\b(?:data_like_reaction_motion_map|data_likes_list)\b/.test(
        node.textContent || "",
      ),
  );
}

// When Bangumi reaches the end of a categorized timeline it may omit the
// #timeline element entirely. Accept that shape only when the surrounding
// category shell and reaction assets prove this is a real empty page.
function isTietieEmptyPage(document, tabs, category, baseUrl) {
  const content = document?.querySelector?.("#tmlContent");
  if (!content || !hasActiveTietieCategory(tabs, category, baseUrl)) {
    return false;
  }
  if (
    content.querySelector?.("#timeline, .tml_item, #tmlPager") ||
    document.querySelector?.("#tmlPager")
  ) {
    return false;
  }

  let templateCount = 0;
  let scriptCount = 0;
  for (const node of content.childNodes || []) {
    if (node.nodeType === 3) {
      if (node.textContent.trim() !== "") return false;
      continue;
    }
    if (isTietieReactionTemplate(node)) {
      templateCount += 1;
      continue;
    }
    if (isTietieInitializationScript(node)) {
      scriptCount += 1;
      continue;
    }
    return false;
  }
  return templateCount > 0 && scriptCount > 0;
}

function parseTietieTimelineDocument(
  document,
  { baseUrl = "https://bgm.tv/", category, page = 1 } = {},
) {
  const tabs = document?.querySelector?.("#timelineTabs");
  const timeline = document?.querySelector?.("#tmlContent > #timeline");
  if (!tabs) return { kind: "invalid" };
  if (!timeline) {
    return isTietieEmptyPage(document, tabs, category, baseUrl)
      ? { kind: "empty", contents: [], hasNextPage: false }
      : { kind: "invalid" };
  }

  const items = [...(timeline.querySelectorAll?.(".tml_item") || [])];
  if (items.length === 0) {
    return timeline.textContent.trim() === ""
      ? { kind: "empty", contents: [], hasNextPage: false }
      : { kind: "invalid" };
  }

  const data = tietieDataFor(document);
  if (!data) return { kind: "invalid" };

  const contents = [];
  for (const item of items) {
    const reactionDataKey = reactionDataKeyFor(item);
    const contentKey = contentKeyForTietieItem(item, baseUrl, category);
    const dynamicIdentifier = dynamicIdentifierFor(item);
    const reactionContainerIdentifier = reactionContainerIdentifierFor(item);

    if (!reactionDataKey) {
      if (!isReactionlessCollectionItem(item, category, contentKey, baseUrl)) {
        return { kind: "invalid" };
      }
      contents.push({
        contentKey,
        dynamicIdentifier,
        reactionContainerIdentifier,
        reactorIdentifiers: [],
      });
      continue;
    }
    if (!data) return { kind: "invalid" };

    const reactorIdentifiers = reactionUsersFor(data[reactionDataKey]);
    if (reactorIdentifiers === null) return { kind: "invalid" };
    contents.push({
      contentKey,
      dynamicIdentifier,
      reactionContainerIdentifier,
      reactorIdentifiers,
    });
  }

  return {
    kind: "success",
    contents,
    hasNextPage: nextTietiePage(document, page, baseUrl),
  };
}

export { TIETIE_CATEGORIES, parseTietieTimelineDocument };
