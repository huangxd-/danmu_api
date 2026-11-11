import { AsyncLocalStorage } from 'node:async_hooks';
import { globals } from '../configs/globals.js';

// Keep color/gradient rules stable while an upstream request is in flight.
const commentContext = new AsyncLocalStorage();

export function getCommentTransformConfig() {
  return commentContext.getStore() ?? Object.freeze({
    gradientEnabled: globals.gradientEnabled,
    gradientChance: globals.gradientChance,
    convertColor: globals.convertColor,
    colorPool: globals.colorPool,
    convertTopBottomToScroll: globals.convertTopBottomToScroll,
    danmuOffsetRules: globals.danmuOffsetRules,
    blockedWords: globals.blockedWords,
    danmuSimplifiedTraditional: globals.danmuSimplifiedTraditional,
    groupMinute: globals.groupMinute,
    danmuLimit: globals.danmuLimit,
    likeSwitch: globals.likeSwitch,
    deferProcessing: false,
    revision: globals.commentTransformRevision,
  });
}

export function runWithCommentTransform(task, { deferProcessing = false } = {}) {
  if (commentContext.getStore()) return task();
  return commentContext.run(Object.freeze({ ...getCommentTransformConfig(), deferProcessing }), task);
}
