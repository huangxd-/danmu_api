// 本地预览生成：用 Node 渲染 HTML_TEMPLATE 与接口详情渲染函数，产出可离线打开的页面
// 不参与 node --test 自动发现。运行方式：
//   node danmu_api/tests/manual/render-interface-detail-preview.js
// 产物写入仓库根目录 docs/interface-detail-preview.html，仅本地留存。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInterfaceDetailPage } from '../helpers/interface-detail.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../../../docs/interface-detail-preview.html');

const html = await renderInterfaceDetailPage();
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, html, 'utf8');
console.log(`已生成接口详情布局预览: ${output} (${html.length} 字符)`);
