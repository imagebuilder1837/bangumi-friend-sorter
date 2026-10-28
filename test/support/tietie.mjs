import { documentFromFixture } from "./html.mjs";

// 分类时间胶囊响应：真实 DOM fixture 加上请求对应的主页身份与分类导航。
function tietieDocumentFor({
  recipientIdentifier = "viewed",
  category = "say",
  fixture = "timeline-tietie.html",
} = {}) {
  const document = documentFromFixture(fixture);
  const path = `/user/${encodeURIComponent(recipientIdentifier)}`;
  for (const anchor of document.querySelectorAll("a[href]")) {
    anchor.setAttribute(
      "href",
      anchor.getAttribute("href").replace("/user/visitor/", `${path}/`),
    );
  }
  const tabs = document.querySelector("#timelineTabs");
  const active = document.createElement("a");
  active.className = "focus";
  active.setAttribute("href", `${path}/timeline?type=${category}`);
  tabs.replaceChildren(active);
  const profile = document.createElement("div");
  profile.id = "headerProfile";
  profile.innerHTML = '<div class="headerAvatar"><a></a></div>';
  profile.querySelector("a").setAttribute("href", path);
  document.body.prepend(profile);
  return document;
}

export { tietieDocumentFor };
