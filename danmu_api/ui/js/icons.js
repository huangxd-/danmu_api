// language=JavaScript
// 界面图标库：集中定义界面使用的线性图标，统一 24×24 网格、2px 圆头描边。
// UI_ICON_PATHS —— 图标名到 SVG 图形的映射；
// iconsSpriteContent —— 内联 SVG sprite，供 <use> 引用；
// renderIcon / iconJsContent —— 分别供服务端模板与浏览器动态内容生成 <use> 引用。
// 图标颜色与尺寸统一由 components.css.js 的 .ui-icon 控制。

// 图标几何数据：名称 -> symbol 内部图形
const UI_ICON_PATHS = {
    // ===== 明暗模式切换 =====
    // 太阳：明暗切换按钮在暗色模式下显示
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M6.35 17.65l-1.42 1.42M19.07 4.93l-1.42 1.42"/>',
    // 月亮：明暗切换按钮在亮色模式下显示
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/>',

    // ===== 状态提示 =====
    // 星光：页头「最新版本」徽标
    sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M18.4 15.3l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>',
    // 标签：页头「当前版本」徽标
    tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><path d="M7 7h.01"/>',
    // 警告三角：配置获取失败、Cookie/API Key 未配置、检测失败
    'alert-triangle': '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4M12 17h.01"/>',
    // 成功圆：已登录、扫码登录成功、连通性测试通过
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8.4 12.4l2.5 2.5 4.7-4.9"/>',
    // 失败圆：Cookie 失效、二维码过期、连通性测试失败
    'x-circle': '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
    // 时钟：等待扫码、正在生成二维码、请求记录时间戳
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 1.9"/>',

    // ===== 通用操作 =====
    // 刷新：刷新日志、刷新请求记录、解析并更新映射列表
    'refresh-cw': '<path d="M21 3v5h-5"/><path d="M3 21v-5h5"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L21 8"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L3 16"/>',
    // 加号：添加映射项、添加规则
    plus: '<path d="M12 5v14M5 12h14"/>',
    // 垃圾桶：清空日志、清理缓存
    'trash-2': '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6M14 11v6"/>',
    // 上传（托盘 + 向上箭头）：导出配置文件
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
    // 下载（托盘 + 向下箭头）：导入配置文件
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
    // 云 + 上行箭头：重新部署系统
    'cloud-up': '<path d="M17.5 11H6.5a3 3 0 0 1-.5-5A6 6 0 0 1 17 6a3 3 0 0 1 .5 5z"/><path d="M12 21v-6.6"/><path d="M8.7 17.7l3.3-3.3 3.3 3.3"/>',
    // 复制：复制配置值
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    // 软盘：Bilibili Cookie 待保存提示
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8"/><path d="M7 3v5h8"/>',

    // ===== 勾选与方向 =====
    // 对勾：复制成功、合并确认、映射「匹配」状态
    check: '<path d="M20 6L9 17l-5-5"/>',
    // 叉：映射「落单」状态
    x: '<path d="M18 6L6 18M6 6l12 12"/>',
    // 向上箭头：数字步进器增大、收起规则面板
    'chevron-up': '<path d="M18 15l-6-6-6 6"/>',
    // 向下箭头：数字步进器减小
    'chevron-down': '<path d="M6 9l6 6 6-6"/>',
    // 向右箭头：总览卡片进入指示
    'chevron-right': '<path d="M9 18l6-6-6-6"/>',
    // 向左箭头：返回上一级
    'chevron-left': '<path d="M15 18l-6-6 6-6"/>',

    // ===== 导航与分类 =====
    // 链接：API 配置分类、开启合并模式、被合并源数量徽标
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    // 断开链接：关闭合并模式
    unlink: '<path d="M18.84 12.25l1.72-1.71a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M5.17 11.75l-1.71 1.71a5 5 0 0 0 7.07 7.07l1.71-1.71"/><path d="M8 2v3M2 8h3M16 22v-3M22 16h-3"/>',
    // 叠层：源配置分类
    layers: '<path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    // 放大镜：匹配配置分类、检测中状态
    search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5l-4.4-4.4"/>',
    // 评论气泡（方形 + 文本行）：弹幕配置分类
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 8h8M8 12h5"/>',
    // 数据库（圆柱）：缓存配置分类
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/>',
    // 齿轮：系统配置分类
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    // 四宫格：配置总览按钮
    'layout-grid': '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    // 列表：展开 / 收起映射详情
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    // 柱状图：查看最近数据
    'bar-chart': '<path d="M3 21h18"/><path d="M6 21v-9M12 21V5M18 21v-6"/>',
    // 胶片：剧集数量徽标
    film: '<rect x="2" y="3" width="20" height="18" rx="2"/><path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5"/>',
    // 二维码：扫码登录
    'qr-code': '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3z"/><path d="M21 14v3M21 21h.01M14 21h3"/>',
    // 锥形瓶：AI API Key 连通性测试
    flask: '<path d="M10 2v7.3L4.6 18.9A1.5 1.5 0 0 0 5.9 21h12.2a1.5 1.5 0 0 0 1.3-2.1L14 9.3V2"/><path d="M8.5 2h7"/><path d="M7.2 14h9.6"/>',
};

// 内联 SVG sprite：集中所有 <symbol> 定义，供 <use href="#icon-..."> 引用
export const iconsSpriteContent = `<svg class="ui-icon-sprite" aria-hidden="true" focusable="false">${Object.entries(UI_ICON_PATHS).map(([name, paths]) => `<symbol id="icon-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</symbol>`).join('')}</svg>`;

// 服务端模板用（template.js 在 Node 中拼接 HTML 时调用）：生成引用 sprite 的图标
export function renderIcon(name, className = 'ui-icon') {
    return `<svg class="${className}" aria-hidden="true" focusable="false"><use href="#icon-${name}"></use></svg>`;
}

// 浏览器动态内容用（注入页面 <script>）：与 renderIcon 保持同一份标记结构
export const iconJsContent = /* javascript */ `
function uiIcon(name, className = 'ui-icon') {
    return '<svg class="' + className + '" aria-hidden="true" focusable="false"><use href="#icon-' + name + '"></use></svg>';
}

// 以图标 + 纯文本渲染状态行，图标与文字由 flex 容器居中，文本用 textContent 写入
function uiSetStatus(el, name, text) {
    if (!el) return;
    el.innerHTML = '<span class="ui-icon-label">' + uiIcon(name) + '<span class="ui-status-text"></span></span>';
    el.querySelector('.ui-status-text').textContent = text;
}
`;
