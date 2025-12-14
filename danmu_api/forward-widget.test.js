// 测试 forward-widget.js 中定义的弹幕获取功能
import { searchDanmu, getDetailById, getCommentsById, getDanmuWithSegmentTime } from './forward-widget.js';

// 模拟参数
const testParams = {
  keyword: '测试',
  id: 1,
  url: 'https://v.qq.com/x/cover/test.html'
};

console.log('开始测试 forward-widget.js 中的弹幕获取功能...');

// 测试搜索功能
async function testSearch() {
  try {
    console.log('测试搜索功能...');
    const searchResult = await searchDanmu({ keyword: '生万物' });
    console.log('搜索结果:', searchResult);
  } catch (error) {
    console.error('搜索功能测试失败:', error);
  }
}

// 测试详情获取功能
async function testDetail() {
  try {
    console.log('测试详情获取功能...');
    // 使用一个已知存在的bangumi ID进行测试
    const detailResult = await getDetailById({ id: 236379 }); // 生万物的ID
    console.log('详情结果:', detailResult);
  } catch (error) {
    console.error('详情获取功能测试失败:', error);
  }
}

// 测试弹幕获取功能
async function testComments() {
 try {
    console.log('测试弹幕获取功能...');
    // 使用一个更可靠的测试URL
    const commentsResult = await getCommentsById({ url: 'https://v.qq.com/x/cover/mzcovl7570x3508.html' });
    console.log('弹幕结果:', commentsResult);
  } catch (error) {
    console.error('弹幕获取功能测试失败:', error);
  }
}

// 测试时间段弹幕获取功能
async function testSegmentTime() {
  try {
    console.log('测试时间段弹幕获取功能...');
    const segmentResult = await getDanmuWithSegmentTime({ 
      url: 'https://v.qq.com/x/cover/mzcovl7570x3508.html',
      startTime: 0,
      endTime: 300 // 前5分钟
    });
    console.log('时间段弹幕结果:', segmentResult);
  } catch (error) {
    console.error('时间段弹幕获取功能测试失败:', error);
  }
}

// 运行测试
testSearch();
testDetail();
testComments();
testSegmentTime();

console.log('测试完成');
