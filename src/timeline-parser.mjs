// src/timeline-parser.mjs — activity timeline parsing.

const SITE_OFFSET_SECONDS = 8 * 60 * 60;

function siteDateFromEpochSeconds(epochSeconds) {
  return new Date((epochSeconds + SITE_OFFSET_SECONDS) * 1_000);
}

function parseSiteTimestampParts(value) {
  const match =
    /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
      value || "",
    );
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    match;
  const [year, month, day, hour, minute] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
  ].map(Number);
  const second = secondText === undefined ? 0 : Number(secondText);
  const parsedSeconds =
    Date.UTC(year, month - 1, day, hour, minute, second) / 1_000 -
    SITE_OFFSET_SECONDS;
  const parsed = siteDateFromEpochSeconds(parsedSeconds);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return null;
  }
  return {
    day,
    epochSeconds: parsedSeconds,
    hasExplicitSeconds: secondText !== undefined,
    hour,
    minute,
    month,
    second,
    year,
  };
}

function parseRelativeTime(value) {
  const text = (value || "").trim();
  if (text === "刚刚") return { totalSeconds: 0 };
  if (!text.endsWith("前")) return null;

  const body = text.slice(0, -1);
  const unitRanks = { 年: 5, 月: 4, 天: 3, 小时: 2, 分: 1, 分钟: 1, 秒: 0 };
  const tokens = [];
  const tokenPattern = /(\d+)(年|月|天|小时|分(?:钟)?|秒)/g;
  let cursor = 0;
  let match;
  while ((match = tokenPattern.exec(body))) {
    if (match.index !== cursor) return null;
    tokens.push({
      amount: Number(match[1]),
      rank: unitRanks[match[2]],
      // 分钟 and 分 are the same relative unit; normalize so the
      // second-recovery checks below only need the canonical names.
      unit: match[2] === "分钟" ? "分" : match[2],
    });
    cursor = tokenPattern.lastIndex;
  }
  if (cursor !== body.length || tokens.length < 1 || tokens.length > 2)
    return null;
  if (tokens.length === 2 && tokens[1].rank !== tokens[0].rank - 1) return null;

  const hasExplicitSeconds = tokens.some(({ unit }) => unit === "秒");
  const totalSeconds =
    hasExplicitSeconds &&
    tokens.every(({ unit }) => unit === "分" || unit === "秒")
      ? tokens.reduce(
          (total, token) =>
            total + token.amount * (token.unit === "分" ? 60 : 1),
          0,
        )
      : null;
  return { totalSeconds };
}

function matchesSiteMinute(epochSeconds, timestampParts) {
  const siteDate = siteDateFromEpochSeconds(epochSeconds);
  return (
    siteDate.getUTCFullYear() === timestampParts.year &&
    siteDate.getUTCMonth() === timestampParts.month - 1 &&
    siteDate.getUTCDate() === timestampParts.day &&
    siteDate.getUTCHours() === timestampParts.hour &&
    siteDate.getUTCMinutes() === timestampParts.minute
  );
}

function parseTimelineDocument(document, referenceAtSeconds) {
  const tabs = document.querySelector("#timelineTabs");
  const timeline = document.querySelector("#tmlContent > #timeline");
  if (!tabs || !timeline) return { kind: "invalid" };

  const firstItem = timeline?.querySelector(".tml_item");
  if (!firstItem) {
    return timeline.textContent.trim() === ""
      ? { kind: "empty" }
      : { kind: "invalid" };
  }

  const timestampNode = firstItem?.querySelector(
    ".post_actions .titleTip[title]",
  );
  const timestamp = timestampNode?.getAttribute("title");
  const timestampParts = parseSiteTimestampParts(timestamp);
  let activityAtSeconds = timestampParts?.epochSeconds ?? null;

  if (
    activityAtSeconds !== null &&
    !timestampParts.hasExplicitSeconds &&
    Number.isFinite(referenceAtSeconds)
  ) {
    const relative = parseRelativeTime(timestampNode.textContent);
    if (
      relative?.totalSeconds !== null &&
      relative?.totalSeconds !== undefined
    ) {
      const inferred = Math.trunc(referenceAtSeconds) - relative.totalSeconds;
      if (matchesSiteMinute(inferred, timestampParts))
        activityAtSeconds = inferred;
    }
  }

  return activityAtSeconds === null
    ? { kind: "invalid" }
    : { kind: "active", activityAtSeconds };
}

export { parseTimelineDocument };
