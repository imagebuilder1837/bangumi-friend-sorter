// src/remote-selection.mjs — remote target transition decisions.
import { REMOTE_TARGET_SELECTION_KEYS, REFRESH_STATUS } from "./choices.mjs";

function remoteTargetFor(criterion, selection) {
  const selectionKey = REMOTE_TARGET_SELECTION_KEYS[criterion];
  if (selectionKey === undefined) return null;
  return {
    kind: criterion,
    ...(selectionKey ? { [selectionKey]: selection } : {}),
  };
}

function sameRemoteTarget(left, right) {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  const selectionKey = REMOTE_TARGET_SELECTION_KEYS[left.kind];
  return !selectionKey || left[selectionKey] === right[selectionKey];
}

function nextRemoteSelectionAction(currentTarget, requestedTarget, statusKind) {
  const clearPrompt = statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH;
  const selectAction = (refreshMode = null) => ({
    kind: "select",
    clearPrompt,
    refreshMode,
  });

  // 唯一调用方 selectRemoteCriterion 只对 activity/relation/completion
  // 传入非空目标；requestedTarget === null 的分支已随其直测一并移除。
  if (!sameRemoteTarget(currentTarget, requestedTarget)) {
    return selectAction("incremental");
  }
  if (statusKind === REFRESH_STATUS.IDLE) {
    return { kind: "arm", clearPrompt: false, refreshMode: null };
  }
  if (statusKind === REFRESH_STATUS.AWAITING_FULL_REFRESH) {
    return {
      kind: "refresh",
      clearPrompt: true,
      refreshMode: "full",
    };
  }
  // The caller bails out on "ignore" without reading any other field.
  return { kind: "ignore" };
}

export { remoteTargetFor, sameRemoteTarget, nextRemoteSelectionAction };
