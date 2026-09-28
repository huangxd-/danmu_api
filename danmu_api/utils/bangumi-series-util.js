import { log } from './log-util.js';
import { cleanBangumiTitle, bangumiFetch, scoreBangumiSubject, getBangumiSubjectDetail } from './bangumi-api-util.js';

const BANGUMI_SERIES_SUBJECT_TYPES = [6]; // Live action series; exclude books.

async function scoreBangumiSeriesCandidate(subject, queryTitle, year = null, season = null) {
  let score = scoreBangumiSubject(subject, queryTitle, year, season);
  let detail = subject;

  if (score < 60 && subject?.id) {
    const subjectDetail = await getBangumiSubjectDetail(subject.id);
    if (subjectDetail) {
      const detailScore = scoreBangumiSubject(subjectDetail, queryTitle, year, season);
      if (detailScore > score) {
        score = detailScore;
        detail = subjectDetail;
      }
    }
  }

  return { score, detail };
}

/**
 * 使用 Bangumi 作为中文同系列标题候选源。
 * 只查询三次元(type=6)，用于给弹幕源搜索补充候选标题，不参与外文翻译。
 */
export async function getBangumiSeriesTitleCandidates(title, seasonYear = null, season = null) {
  const cleanTitle = cleanBangumiTitle(title);
  if (!cleanTitle || !seasonYear) return [];

  try {
    const searchData = await bangumiFetch('/v0/search/subjects', {
      method: 'POST',
      body: JSON.stringify({
        keyword: cleanTitle,
        filter: { type: BANGUMI_SERIES_SUBJECT_TYPES }
      })
    });

    const subjects = Array.isArray(searchData?.data) ? searchData.data : [];
    const sameYearSubjects = subjects
      .filter(subject => Number(String(subject?.date || '').slice(0, 4)) === Number(seasonYear))
      .slice(0, 10);
    const results = [];

    for (const subject of sameYearSubjects) {
      const { score, detail } = await scoreBangumiSeriesCandidate(subject, cleanTitle, seasonYear, season);
      if (score < 60) {
        log('info', `[Utils] [Bangumi] 跳过低相关同系列候选: ${cleanTitle} -> ${cleanBangumiTitle(subject?.name_cn || subject?.name)} (score: ${score.toFixed(1)})`);
        continue;
      }

      const candidateTitle = cleanBangumiTitle(detail?.name_cn || detail?.name || subject?.name_cn || subject?.name);
      if (!candidateTitle) continue;

      results.push({
        title: candidateTitle,
        year: String(detail?.date || subject?.date || '').slice(0, 4),
        source: 'bangumi',
        id: subject?.id,
        score
      });
    }

    return results;
  } catch (error) {
    log('warn', `[Utils] [Bangumi] 同系列标题候选查询失败: ${error.message}`);
    return [];
  }
}
