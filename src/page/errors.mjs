// src/page/errors.mjs — visible failures, separate from refresh progress.
function createPageErrorReporter(
  pageDocument,
  { list, logger = pageDocument.defaultView?.console ?? console },
) {
  const reported = new Set();
  let notice;
  return (stage, error) => {
    if (reported.has(error)) return;
    reported.add(error);
    logger.error(`好友排序：${stage}失败`, error);
    if (!notice) {
      notice = pageDocument.createElement("p");
      notice.setAttribute("role", "alert");
      list.before(notice);
    }
    notice.textContent = `好友排序：${stage}失败：${error?.message ?? String(error)}`;
  };
}

export { createPageErrorReporter };
