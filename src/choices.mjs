// src/choices.mjs — sorting choices and remote field shape.

const SORT = Object.freeze({
  ACTIVITY: "activity",
  ADDED: "added",
  COMPLETION: "completion",
  NAME: "name",
  RELATION: "relation",
  TIETIE: "tietie",
});
const COMPLETION_SCOPE = Object.freeze({
  ALL: "all",
  ANIMATION: "2",
  BOOK: "1",
  MUSIC: "3",
  GAME: "4",
  REAL_LIFE: "6",
});
const DIRECTION = Object.freeze({
  ASCENDING: "asc",
  DESCENDING: "desc",
});
const REFRESH_STATUS = Object.freeze({
  COMPLETED: "completed",
  FETCHING: "fetching",
  IDLE: "idle",
  // 两阶段全量刷新的待命状态：提示再次点击以全量刷新，5 秒后自动清除。
  AWAITING_FULL_REFRESH: "armed",
  LOGIN_REQUIRED: "login",
});
const SORT_CHOICES = [
  [SORT.ADDED, "加好友时间"],
  [SORT.NAME, "名称"],
  [SORT.ACTIVITY, "上次活跃"],
  [SORT.TIETIE, "和我贴贴"],
];
const COMPLETION_CHOICES = [
  [COMPLETION_SCOPE.ALL, "全部"],
  [COMPLETION_SCOPE.ANIMATION, "动画"],
  [COMPLETION_SCOPE.BOOK, "书籍"],
  [COMPLETION_SCOPE.MUSIC, "音乐"],
  [COMPLETION_SCOPE.GAME, "游戏"],
  [COMPLETION_SCOPE.REAL_LIFE, "三次元"],
];
const RELATION_CHOICES = [
  ["syncRate", "同步率"],
  ["commonLikes", "共同喜好数"],
];
const REMOTE_TARGET_SELECTION_KEYS = Object.freeze({
  [SORT.ACTIVITY]: null,
  [SORT.COMPLETION]: "scope",
  [SORT.RELATION]: "metric",
  [SORT.TIETIE]: null,
});

export {
  SORT,
  COMPLETION_SCOPE,
  DIRECTION,
  REFRESH_STATUS,
  SORT_CHOICES,
  COMPLETION_CHOICES,
  RELATION_CHOICES,
  REMOTE_TARGET_SELECTION_KEYS,
};
