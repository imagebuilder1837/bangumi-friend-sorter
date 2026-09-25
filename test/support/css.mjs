function topLevelCssRules(css) {
  const rules = [];
  let prelude = "";
  let block = null;
  let depth = 0;
  let inComment = false;
  let quote = null;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    const next = css[i + 1];
    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      ((block ??= prelude), (block += char));
      continue;
    }
    if (char === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      throw new Error(
        `CSS does not support // comments (offset ${i}); the browser absorbs them into the next selector and drops the rule`,
      );
    }
    if (char === '"' || char === "'") quote = char;
    if (block === null) {
      if (char === "{") {
        block = "";
        depth = 1;
      } else {
        prelude += char;
      }
    } else if (char === "{") {
      depth += 1;
      block += char;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({ block, prelude });
        block = null;
        prelude = "";
      } else {
        block += char;
      }
    } else {
      block += char;
    }
  }
  return rules;
}

function normalizeCssSelector(selector) {
  return selector.replace(/\s+/g, " ").trim();
}

export { topLevelCssRules, normalizeCssSelector };
