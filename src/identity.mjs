// src/identity.mjs — friend and visitor identifiers.

// Normalizes a friend record to its stable cache and sort identity:
// only a non-empty string identifier counts (see CONTEXT.md, 用户标识).
function userIdentifierFor(friend) {
  const identifier = friend?.userIdentifier;
  return typeof identifier === "string" && identifier ? identifier : null;
}
function positiveIntegerIdentifier(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  return text;
}

function userIdentifierFromHref(href, baseUrl) {
  try {
    const pathname = new URL(href, baseUrl).pathname;
    const match = /^\/user\/([^/]+)\/?$/.exec(pathname);
    return match ? decodeURIComponent(match[1]) || null : null;
  } catch {
    return null;
  }
}

function currentVisitorIdentifier(pageDocument, pageWindow) {
  // Bangumi redirects numeric user paths to the default timeline and drops
  // the type query, so categorized timeline requests must prefer the stable
  // username path when the page exposes both identifiers.
  const visitorIdentifierCandidate = pageWindow?.CHOBITS_USERNAME;
  if (
    typeof visitorIdentifierCandidate === "string" &&
    visitorIdentifierCandidate.trim()
  ) {
    return visitorIdentifierCandidate.trim();
  }

  const uid = positiveIntegerIdentifier(pageWindow?.CHOBITS_UID);
  if (uid) return uid;

  const selectors = [
    "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']",
    "#headerNeue2 a.avatar[href*='/user/']",
    ".idBadgerNeue a.avatar[href*='/user/']",
  ];
  for (const selector of selectors) {
    let avatar;
    try {
      avatar = pageDocument?.querySelector?.(selector);
    } catch {
      continue;
    }
    const identifier = userIdentifierFromHref(
      avatar?.getAttribute?.("href"),
      pageWindow?.location?.href,
    );
    if (identifier) return identifier;
  }
  return null;
}

export { userIdentifierFor, userIdentifierFromHref, currentVisitorIdentifier };
