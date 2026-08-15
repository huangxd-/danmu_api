// language=CSS
export const responsiveCssContent = /* css */ `
/* 响应式 — 参照 Bangumi-syncer 多断点策略 */

/* ============ 平板 (<= 992px) ============ */
@media (max-width: 992px) {
    .preview-overview {
        grid-template-columns: repeat(2, minmax(0, 1fr));
    }
}

/* ============ 手机 (<= 768px) ============ */
@media (max-width: 768px) {
    body {
        padding: 6px;
    }

    body::before {
        display: none;
    }

    .container {
        border-radius: 14px;
        box-shadow: var(--app-shadow-md);
    }

    .header {
        padding: 12px 14px;
    }

    .logo {
        width: 36px;
        height: 36px;
        font-size: 20px;
        border-radius: 10px;
    }

    .header-left {
        width: 100%;
        flex-direction: column;
        align-items: flex-start;
    }

    .logo-title-container {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: 8px;
    }

    .header h1 {
        font-size: 19px;
        margin: 0;
    }

    .version-info {
        font-size: 11px;
        flex-wrap: wrap;
        margin-top: 4px;
        width: 100%;
    }

    .nav-buttons {
        width: 100%;
        flex-wrap: wrap;
        gap: 5px;
        justify-content: center;
    }

    .nav-btn {
        flex: 1 1 calc(33.333% - 5px);
        text-align: center;
        font-size: 13px;
        padding: 9px 6px;
        white-space: nowrap;
        min-width: 60px;
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .content {
        padding: 14px;
    }

    .env-item {
        flex-direction: column;
        align-items: flex-start;
    }

    .env-actions {
        width: 100%;
    }

    .favorite-action-btn {
        max-width: none;
        flex-basis: 100%;
    }

    .btn {
        flex: 1;
    }

    .preview-toolbar {
        align-items: stretch;
        flex-direction: column;
        gap: 8px;
        padding-top: 8px;
    }

    .preview-categories {
        order: 1;
        width: 100%;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
        gap: 5px;
        overflow: visible;
    }

    .preview-category-btn {
        width: 100%;
        min-width: 0;
        justify-content: space-between;
    }

    .preview-back-btn {
        grid-column: 1 / -1;
        width: calc((100% - 10px) / 3);
        min-width: 0;
        justify-self: start;
    }

    .preview-search {
        order: 2;
        flex: none;
        width: 100%;
        min-width: 0;
    }

    .preview-overview {
        grid-template-columns: 1fr;
    }

    .preview-summary {
        min-height: 88px;
    }

    .preview-item {
        padding: 10px 4px;
    }

    .preview-item-main {
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
    }

    .preview-key {
        padding-top: 0;
    }

    .preview-value-container {
        align-items: stretch;
        flex-direction: column;
    }

    .preview-value-actions {
        align-self: flex-end;
    }

    .preview-item-description {
        margin: 6px 0 0;
    }

    .record-header {
        flex-direction: column;
        align-items: stretch;
    }

    .record-method,
    .record-interface,
    .record-ip {
        width: 100%;
        box-sizing: border-box;
    }

    .footer {
        border-radius: 14px;
        padding: 14px 16px;
        font-size: 12px;
        margin: 8px auto 0;
        width: calc(100% - 12px);
        box-sizing: border-box;
    }

    .footer-bar {
        margin: 4px auto 0;
        padding: 6px 12px;
        font-size: 11px;
        gap: 4px 10px;
        width: calc(100% - 12px);
        box-sizing: border-box;
    }

    .theme-settings {
        flex-direction: column;
        align-items: stretch;
    }

    .theme-options {
        grid-template-columns: repeat(4, minmax(0, 1fr));
    }
}

/* ============ 小屏手机 (<= 480px) ============ */
@media (max-width: 480px) {
    .header h1 {
        font-size: 18px;
    }

    .nav-btn {
        flex: 1 1 calc(33.333% - 4px);
        font-size: 11px;
        padding: 7px 4px;
        max-width: none;
    }

    .preview-overview {
        gap: 6px;
    }

    .preview-category-btn {
        font-size: 11px;
        padding: 5px 8px;
    }

    .modal-content {
        padding: 20px;
        border-radius: 16px;
    }
}

.search-actions {
    display: flex;
    gap: 10px;
    margin-top: 5px;
    flex-wrap: wrap;
}

/* 手机端：输入框独占第一行，收藏和搜索按钮并排 */
@media (max-width: 500px) {
    .search-actions input {
        flex-basis: 100%;
        min-width: 100%;
        order: 1;
    }
    .search-actions .favorite-action-btn {
        flex: 1;
        order: 2;
    }
    .search-actions #manual-search-btn {
        flex: 1;
        order: 3;
    }
}

/* 剧集操作按钮：PC 窄 120px、平板适中 160px、手机窄 100px */
.episode-item .btn,
.jump-episode-btn {
    max-width: 120px;
}

@media (min-width: 501px) and (max-width: 768px) {
    .episode-item .btn,
    .jump-episode-btn {
        max-width: 160px;
    }
}

@media (max-width: 500px) {
    .episode-item .btn,
    .jump-episode-btn {
        max-width: 100px;
    }
}
`;