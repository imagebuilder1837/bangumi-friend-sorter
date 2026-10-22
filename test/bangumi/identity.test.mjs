import test from "node:test";
import assert from "node:assert/strict";
import { currentVisitorIdentifier } from "../../src/bangumi/identity.mjs";
test("当前访问者标识按配置的访问者标识、UID、页头头像依次回退且不读取被查看者", () => {
  const avatar = { getAttribute: () => "/user/header-user" };
  const headerDocument = {
    querySelector(selector) {
      return selector === "#headerNeue2 .idBadgerNeue a.avatar[href*='/user/']"
        ? avatar
        : null;
    },
  };

  assert.equal(
    currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "42",
      CHOBITS_USERNAME: "name",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "name",
  );
  assert.equal(
    currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "9007199254740993",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "9007199254740993",
  );
  assert.equal(
    currentVisitorIdentifier(headerDocument, {
      CHOBITS_UID: "0",
      CHOBITS_USERNAME: "  name  ",
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "name",
  );
  assert.equal(
    currentVisitorIdentifier(headerDocument, {
      location: { href: "https://bgm.tv/user/viewed/friends" },
    }),
    "header-user",
  );
  assert.equal(
    currentVisitorIdentifier(
      { querySelector: () => null },
      { location: { href: "https://bgm.tv/user/viewed/friends" } },
    ),
    null,
  );
});
