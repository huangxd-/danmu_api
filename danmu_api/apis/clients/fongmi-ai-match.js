import AIClient from "../../utils/ai-util.js";
import { log } from "../../utils/log-util.js";
import { getPreferAnimeId, setPreferByAnimeId, writeCacheToFile } from "../../utils/cache-util.js";
import { setRedisKey } from "../../utils/redis-util.js";
import { setLocalRedisKey } from "../../utils/local-redis-util.js";

const FONGMI_AI_CANDIDATE_LIMIT = 30;
const FONGMI_AI_STRONG_SCORE = 4000;
const FONGMI_AI_SAFE_SCORE_GAP = 5000;

const FONGMI_AI_MATCH_PROMPT = `你是影视弹幕候选选择器。你只负责从 candidates 中选择最适合当前播放内容的一项。

输入 JSON 字段：
- name: 播放器传入的作品名
- episode: 播放器传入的集数、期数、日期或分集标题
- candidates: 候选弹幕列表
  - candidateIndex: 候选下标
  - animeTitle: 候选作品名
  - aliases: 候选作品别名
  - type: 候选类型
  - typeDescription: 候选类型描述
  - startDate: 候选开播日期
  - episodeTitle: 候选分集标题
  - episodeNumber: 候选集序号
  - source: 弹幕来源
  - localScore: 本地规则分数

选择规则，按优先级执行：
1. 先判断 name 与 animeTitle / aliases 是否是同一部作品；同名但类型、年份、别名明显不符时不要选。
2. 同名作品里，要特别区分动画、动漫、番剧、真人电视剧、电影、综艺、剧场版、特别篇。
3. 如果候选同时包含动画版和真人版，且 name 或候选信息不能证明当前是真人版，优先选择动画/动漫/番剧相关候选。
4. 再判断 episode 与 episodeTitle / episodeNumber 是否匹配；集数、期数、日期能精确匹配时优先。
5. 如果 episode 是 SxxExx、纯数字、第几集、第几话、第几期、日期格式，要按对应语义匹配，不要只做字符串相似。
6. localScore 只能作为参考；标题、类型或集数明显不匹配时，不要因为 localScore 高而选择。
7. 如果多个候选都合理，选择标题、类型、集数同时最接近的一项。
8. 如果没有足够把握，返回 null，不要猜。

只返回 JSON，不要解释：
{
  "candidateIndex": 数字 或 null
}`;

function parseFongmiAiJson(aiResponse) {
  const text = String(aiResponse || "").trim();
  if (!text) return null;

  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```|```([\s\S]*?)\s*```|({[\s\S]*})/);
  const jsonString = jsonMatch ? (jsonMatch[1] || jsonMatch[2] || jsonMatch[3]) : text;
  return JSON.parse(jsonString.trim());
}

function getCandidateAnimeId(candidate) {
  return candidate?.anime?.animeId ?? candidate?.anime?.bangumiId ?? null;
}

function getCandidateSource(candidate) {
  return candidate?.anime?.source || null;
}

function sameCandidateWork(a, b) {
  const aId = getCandidateAnimeId(a);
  const bId = getCandidateAnimeId(b);
  const aSource = getCandidateSource(a);
  const bSource = getCandidateSource(b);
  return String(aId ?? "") === String(bId ?? "") && String(aSource ?? "") === String(bSource ?? "");
}

function findPreferredCandidate(name, matchedKeyword, candidates) {
  const keys = [...new Set([matchedKeyword, name].filter(Boolean))];

  for (const key of keys) {
    const [preferAnimeId, preferSource] = getPreferAnimeId(key);
    if (!preferAnimeId) continue;

    const preferredCandidate = candidates.find(candidate => {
      const candidateId = getCandidateAnimeId(candidate);
      const candidateSource = getCandidateSource(candidate);
      const animeMatches =
        String(candidateId) === String(preferAnimeId) ||
        String(candidate?.anime?.bangumiId ?? "") === String(preferAnimeId);
      const sourceMatches = !preferSource || String(candidateSource) === String(preferSource);
      return animeMatches && sourceMatches;
    });

    if (preferredCandidate) {
      log("info", `[Fongmi][Prefer] selected by lastSelectMap: key=${key}, animeId=${preferAnimeId}, source=${preferSource || ""}`);
      return preferredCandidate;
    }
  }

  return null;
}

function shouldUseFongmiAi(candidates) {
  if (candidates.length <= 1) return false;

  const top = candidates[0];
  const nextDifferentWork = candidates.find(candidate => !sameCandidateWork(top, candidate));

  if (!nextDifferentWork) {
    return top.score < FONGMI_AI_STRONG_SCORE;
  }

  const scoreGap = top.score - nextDifferentWork.score;
  return top.score < FONGMI_AI_STRONG_SCORE || scoreGap < FONGMI_AI_SAFE_SCORE_GAP;
}

async function persistLastSelectMap(globals) {
  if (globals.localCacheValid) {
    writeCacheToFile("lastSelectMap", JSON.stringify(Object.fromEntries(globals.lastSelectMap)));
  }
  if (globals.redisValid) {
    await setRedisKey("lastSelectMap", globals.lastSelectMap);
  }
  if (globals.localRedisValid) {
    await setLocalRedisKey("lastSelectMap", globals.lastSelectMap);
  }
}

function setPreferForKey(globals, key, animeId, source) {
  const value = globals.lastSelectMap.get(key);
  if (!value?.animeIds?.some(id => String(id) === String(animeId))) return false;

  value.preferBySeason = value.preferBySeason || {};
  value.sourceBySeason = value.sourceBySeason || {};
  value.preferBySeason.default = animeId;
  value.sourceBySeason.default = source;
  globals.lastSelectMap.set(key, value);
  return true;
}

function rememberPreferAnimeId(globals, name, matchedKeyword, animeId, source) {
  const keys = [...new Set([matchedKeyword, name].filter(Boolean))];
  for (const key of keys) {
    if (setPreferForKey(globals, key, animeId, source)) return key;
  }

  return setPreferByAnimeId(animeId, source);
}

async function rememberFongmiAiCandidate(globals, name, matchedKeyword, candidate) {
  const animeId = getCandidateAnimeId(candidate);
  const source = getCandidateSource(candidate);
  if (!animeId) return;

  const updatedKey = rememberPreferAnimeId(globals, name, matchedKeyword, animeId, source);
  if (!updatedKey) {
    log("warn", `[Fongmi][AI] selected animeId=${animeId}, but no lastSelectMap entry was updated`);
    return;
  }

  try {
    await persistLastSelectMap(globals);
    log("info", `[Fongmi][AI] remembered preference: key=${updatedKey}, animeId=${animeId}, source=${source || ""}`);
  } catch (error) {
    log("error", `[Fongmi][AI] failed to persist preference: ${error.message}`);
  }
}

export async function selectFongmiCandidateByAi(globals, name, episode, candidates, matchedKeyword = name) {
  if (!candidates.length) return null;

  const preferredCandidate = findPreferredCandidate(name, matchedKeyword, candidates);
  if (preferredCandidate) return preferredCandidate;

  if (!globals.aiValid || !globals.aiApiKey) return null;
  if (!shouldUseFongmiAi(candidates)) {
    log("info", `[Fongmi][AI] skipped: local score is confident for ${candidates[0].anime?.animeTitle || ""}`);
    return null;
  }

  const candidatePayload = candidates.slice(0, FONGMI_AI_CANDIDATE_LIMIT).map((candidate, index) => ({
    candidateIndex: index,
    animeTitle: candidate.anime?.animeTitle || "",
    aliases: candidate.anime?.aliases || [],
    type: candidate.anime?.type || "",
    typeDescription: candidate.anime?.typeDescription || "",
    startDate: candidate.anime?.startDate || "",
    episodeTitle: candidate.episode?.episodeTitle || "",
    episodeNumber: candidate.episode?.episodeNumber || "",
    source: candidate.anime?.source || "",
    localScore: candidate.score
  }));

  const aiClient = new AIClient({
    apiKey: globals.aiApiKey,
    baseURL: globals.aiBaseUrl,
    model: globals.aiModel,
    systemPrompt: FONGMI_AI_MATCH_PROMPT
  });

  try {
    const aiResponse = await aiClient.ask(JSON.stringify({
      name,
      episode,
      candidates: candidatePayload
    }, null, 2), { maxTokens: 256 });
    log("info", `[Fongmi][AI] match response: ${aiResponse}`);

    const parsedResponse = parseFongmiAiJson(aiResponse);
    const rawSelectedIndex = parsedResponse?.candidateIndex ?? parsedResponse?.index;
    const selectedIndex =
      typeof rawSelectedIndex === "string" && /^\d+$/.test(rawSelectedIndex)
        ? parseInt(rawSelectedIndex, 10)
        : rawSelectedIndex;

    if (selectedIndex === null || selectedIndex === undefined) return null;
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= candidatePayload.length) {
      log("warn", `[Fongmi][AI] Invalid candidateIndex: ${selectedIndex}`);
      return null;
    }

    const selectedCandidate = candidates[selectedIndex];
    await rememberFongmiAiCandidate(globals, name, matchedKeyword, selectedCandidate);
    return selectedCandidate;
  } catch (error) {
    log("error", `[Fongmi][AI] matching failed: ${error.message}`);
    return null;
  }
}
