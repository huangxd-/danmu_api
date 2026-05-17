import AIClient from "../../utils/ai-util.js";
import { log } from "../../utils/log-util.js";
import { getPreferAnimeId, setPreferByAnimeId, writeCacheToFile } from "../../utils/cache-util.js";
import { setRedisKey } from "../../utils/redis-util.js";
import { setLocalRedisKey } from "../../utils/local-redis-util.js";

const FONGMI_AI_STRONG_SCORE = 4000;
const FONGMI_AI_SAFE_SCORE_GAP = 5000;
const FONGMI_AI_COMPACT_LIMIT = 200;
const FONGMI_AI_REGULAR_GROUP_MIN_SIZE = 3;
const FONGMI_AI_REGULAR_GROUP_COVERAGE = 0.8;
const FONGMI_AI_REGULAR_GROUP_UNSAFE_RE = /(?:第\s*\d+\s*期|[上下中](?:\s|$)|纯享|加更|花絮|先导|预告|番外|特别|彩蛋|会员|未播|直播|片段|舞台|合集|抢先|幕后)/;

const FONGMI_AI_MATCH_PROMPT = `你是影视弹幕候选选择器。你只负责从输入候选里选择最适合当前播放内容的一项。

输入 JSON 字段：
- name: 播放器传入的作品名
- episodeRaw: 播放器传入的原始集数、期数、日期、文件名或分集标题，不要假设已经被正确解析
- mode:
  - selectCandidate: 从 candidates/groups 中选择具体分集候选
  - selectGroup: 只从 groups 中选择作品组
- candidates: 可选的精简候选列表，每项为 [candidateId, animeTitle, source, episodeTitle]
- groups: 候选作品组
  - groupId: 作品组 ID
  - animeTitle/source/type/startDate: 作品组信息
  - sampleTitle/pattern/episodes: 规则标题组，episodes 每项为 [candidateId, episodeNo]
  - episodes: 普通标题组，episodes 每项为 [candidateId, episodeTitle]

选择规则，按优先级执行：
1. 先判断 name 与 animeTitle / aliases 是否是同一部作品；同名但类型、年份、别名明显不符时不要选。
2. 同名作品里，要特别区分动画、动漫、番剧、真人电视剧、电影、综艺、剧场版、特别篇。
3. 如果候选同时包含动画版和真人版，且 name 或候选信息不能证明当前是真人版，优先选择动画/动漫/番剧相关候选。
4. 再判断 episodeRaw 与 episodeTitle / pattern / episodeNo 是否匹配；集数、话数、期数、日期、上中下、纯享/加更等版本能精确匹配时优先。
5. 如果 episodeRaw 是文件名，例如 "[1.5 GB]\\"21.mp4\\""，要把其中真实分集理解为第 21 集，但不要被体积、清晰度、年份误导。
6. 综艺要同时看日期、期数、上/中/下、正片/纯享/加更/花絮等版本；同一天不同版本不要互相替代。
7. 规则标题组里的 pattern 只表示标题规律，episodes 里的 candidateId 才是可返回的真实候选。
8. localScore 只能作为参考；标题、类型或集数明显不匹配时，不要因为 localScore 高而选择。
9. 如果没有足够把握，返回 null，不要猜。

mode=selectCandidate 时只返回 JSON，不要解释：
{
  "candidateId": "已有 candidateId" 或 null
}

也可以在非常确定时返回：
{
  "episodeTitle": "输入中精确存在的候选分集标题"
}

mode=selectGroup 时只返回：
{
  "groupId": "已有 groupId" 或 null
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

function getCandidateId(candidate) {
  return candidate?.episode?.episodeId ?? candidate?.episode?.commentId ?? candidate?.episode?.id ?? null;
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCandidateTitle(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractRegularEpisodeNo(title) {
  const text = String(title || "");
  const match = text.match(/第\s*0*(\d{1,4})\s*([集话])/);
  if (!match) return null;

  const episodeNo = parseInt(match[1], 10);
  if (!Number.isInteger(episodeNo) || episodeNo <= 0) return null;
  return {
    value: String(episodeNo),
    suffix: match[2]
  };
}

function buildRegularEpisodePattern(title, episodeNo, suffix) {
  const normalizedTitle = normalizeCandidateTitle(title);
  if (!normalizedTitle || FONGMI_AI_REGULAR_GROUP_UNSAFE_RE.test(normalizedTitle)) return "";

  const noPattern = escapeRegExp(String(parseInt(episodeNo, 10)));
  const paddedNoPattern = `0*${noPattern}`;
  const episodePrefixRe = new RegExp(`第\\s*${paddedNoPattern}\\s*${escapeRegExp(suffix)}`, "g");
  const standaloneNoRe = new RegExp(`(^|[^\\d])0*${noPattern}(?=$|[^\\d])`, "g");

  return normalizedTitle
    .replace(episodePrefixRe, `第{n}${suffix}`)
    .replace(standaloneNoRe, (match, prefix) => `${prefix}{n}`);
}

function buildRegularGroupPayload(group) {
  const templates = new Map();

  for (const candidate of group.candidates) {
    const title = candidate.episode?.episodeTitle || "";
    const episodeNo = extractRegularEpisodeNo(title);
    const candidateId = getCandidateId(candidate);
    if (!episodeNo || candidateId === null) continue;

    const pattern = buildRegularEpisodePattern(title, episodeNo.value, episodeNo.suffix);
    if (!pattern || !pattern.includes("{n}")) continue;

    if (!templates.has(pattern)) {
      templates.set(pattern, {
        pattern,
        sampleTitle: normalizeCandidateTitle(title),
        episodes: [],
        episodeNos: new Set()
      });
    }

    const template = templates.get(pattern);
    if (template.episodeNos.has(episodeNo.value)) continue;
    template.episodeNos.add(episodeNo.value);
    template.episodes.push([String(candidateId), episodeNo.value]);
  }

  const minCoverage = Math.ceil(group.candidates.length * FONGMI_AI_REGULAR_GROUP_COVERAGE);
  const minSize = Math.max(FONGMI_AI_REGULAR_GROUP_MIN_SIZE, minCoverage);
  const best = [...templates.values()].sort((a, b) => b.episodes.length - a.episodes.length)[0];
  if (!best || best.episodes.length < minSize) return null;

  return {
    sampleTitle: best.sampleTitle,
    pattern: best.pattern,
    episodes: best.episodes
  };
}

function buildCandidateGroups(candidates) {
  const groups = [];
  const groupMap = new Map();

  for (const candidate of candidates) {
    const animeId = getCandidateAnimeId(candidate);
    const source = getCandidateSource(candidate);
    const animeTitle = candidate?.anime?.animeTitle || "";
    const groupId = `${source || "unknown"}:${animeId ?? animeTitle}`;

    if (!groupMap.has(groupId)) {
      const group = {
        groupId,
        animeId,
        source,
        animeTitle,
        aliases: candidate?.anime?.aliases || [],
        type: candidate?.anime?.type || "",
        typeDescription: candidate?.anime?.typeDescription || "",
        startDate: candidate?.anime?.startDate || "",
        candidates: []
      };
      groupMap.set(groupId, group);
      groups.push(group);
    }

    groupMap.get(groupId).candidates.push(candidate);
  }

  return groups;
}

function buildGroupPayload(group, { includeEpisodes = true } = {}) {
  const payload = {
    groupId: group.groupId,
    animeTitle: group.animeTitle,
    source: group.source || "",
    type: group.type || "",
    typeDescription: group.typeDescription || "",
    startDate: group.startDate || "",
    count: group.candidates.length,
    topScore: group.candidates[0]?.score ?? 0
  };

  if (group.aliases?.length) payload.aliases = group.aliases.slice(0, 5);
  if (!includeEpisodes) {
    const firstTitle = group.candidates[0]?.episode?.episodeTitle || "";
    if (firstTitle) payload.sampleTitle = normalizeCandidateTitle(firstTitle);
    return payload;
  }

  const regularPayload = buildRegularGroupPayload(group);
  if (regularPayload) {
    return {
      ...payload,
      kind: "regular",
      ...regularPayload
    };
  }

  return {
    ...payload,
    kind: "episodes",
    episodes: group.candidates
      .map(candidate => {
        const candidateId = getCandidateId(candidate);
        const title = normalizeCandidateTitle(candidate?.episode?.episodeTitle || "");
        if (candidateId === null || !title) return null;
        return [String(candidateId), title];
      })
      .filter(Boolean)
  };
}

function findCandidateByAiResponse(parsedResponse, candidates) {
  const rawCandidateId = parsedResponse?.candidateId ?? parsedResponse?.id ?? parsedResponse?.episodeId;
  if (rawCandidateId !== null && rawCandidateId !== undefined) {
    const selected = candidates.find(candidate => String(getCandidateId(candidate)) === String(rawCandidateId));
    if (selected) return selected;
    log("warn", `[Fongmi][AI] Invalid candidateId: ${rawCandidateId}`);
    return null;
  }

  const rawEpisodeTitle = parsedResponse?.episodeTitle ?? parsedResponse?.title;
  if (rawEpisodeTitle) {
    const selected = candidates.find(candidate => candidate?.episode?.episodeTitle === rawEpisodeTitle);
    if (selected) return selected;
    log("warn", `[Fongmi][AI] Invalid episodeTitle: ${rawEpisodeTitle}`);
  }

  return null;
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

async function askFongmiAi(globals, payload) {
  const aiClient = new AIClient({
    apiKey: globals.aiApiKey,
    baseURL: globals.aiBaseUrl,
    model: globals.aiModel,
    systemPrompt: FONGMI_AI_MATCH_PROMPT
  });

  const aiResponse = await aiClient.ask(JSON.stringify(payload), { maxTokens: 256 });
  log("info", `[Fongmi][AI] match response: ${aiResponse}`);
  return parseFongmiAiJson(aiResponse);
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

  const groups = buildCandidateGroups(candidates);

  try {
    let aiCandidates = candidates;
    let payload;

    if (candidates.length <= FONGMI_AI_COMPACT_LIMIT) {
      payload = {
        mode: "selectCandidate",
        name,
        episodeRaw: episode,
        groups: groups.map(group => buildGroupPayload(group))
      };
    } else {
      if (groups.length === 1) {
        aiCandidates = groups[0].candidates;
        payload = {
          mode: "selectCandidate",
          name,
          episodeRaw: episode,
          groups: [buildGroupPayload(groups[0])]
        };
      } else {
        const groupResponse = await askFongmiAi(globals, {
          mode: "selectGroup",
          name,
          episodeRaw: episode,
          groups: groups.map(group => buildGroupPayload(group, { includeEpisodes: false }))
        });
        const groupId = groupResponse?.groupId;
        const selectedGroup = groups.find(group => String(group.groupId) === String(groupId));
        if (!selectedGroup) {
          if (groupId !== null && groupId !== undefined) {
            log("warn", `[Fongmi][AI] Invalid groupId: ${groupId}`);
          }
          return null;
        }

        aiCandidates = selectedGroup.candidates;
        payload = {
          mode: "selectCandidate",
          name,
          episodeRaw: episode,
          groups: [buildGroupPayload(selectedGroup)]
        };
      }
    }

    const parsedResponse = await askFongmiAi(globals, payload);
    const selectedCandidate = findCandidateByAiResponse(parsedResponse, aiCandidates);
    if (!selectedCandidate) return null;

    await rememberFongmiAiCandidate(globals, name, matchedKeyword, selectedCandidate);
    return selectedCandidate;
  } catch (error) {
    log("error", `[Fongmi][AI] matching failed: ${error.message}`);
    return null;
  }
}
