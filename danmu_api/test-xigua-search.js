import XiguaSource from './sources/xigua.js';

async function testXiguaSearch() {
  const xiguaSource = new XiguaSource();
  
  console.log('开始测试西瓜视频搜索功能...');
  
  try {
    // 使用示例关键词进行搜索
    const results = await xiguaSource.search('大宋提刑官');
    console.log('搜索结果:', results);
    
    if (results.length > 0) {
      console.log(`找到 ${results.length} 个结果`);
      console.log('前3个结果:');
      results.slice(0, 3).forEach((result, index) => {
        console.log(`${index + 1}. ${result.title || result.name || result.sid}`);
      });
    } else {
      console.log('未找到任何结果');
    }
  } catch (error) {
    console.error('搜索过程中发生错误:', error);
  }
}

// 直接执行搜索测试
testXiguaSearch();
