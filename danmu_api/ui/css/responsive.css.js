// language=CSS
export const responsiveCssContent = /* css */ `
/* 响应式样式 */
@media (max-width: 768px) {
    .logo {
        width: 40px;
        height: 40px;
        font-size: 22px;
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
        gap: 10px;
    }

    .header h1 {
        font-size: 18px;
        margin: 0;
    }

    .version-info {
        font-size: 11px;
        flex-wrap: wrap;
        margin-top: 5px;
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
        font-size: 11px;
        padding: 8px 5px;
        white-space: nowrap;
        min-width: 70px;
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .env-item {
        flex-direction: column;
        align-items: flex-start;
    }

    .env-actions {
        width: 100%;
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
        order: 2;
        width: 100%;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
        gap: 6px;
        overflow: visible;
    }

    .preview-category-btn {
        width: 100%;
        min-width: 0;
        justify-content: space-between;
    }

    .preview-search {
        order: 1;
        flex: none;
        width: 100%;
        min-width: 0;
    }

    .preview-overview {
        grid-template-columns: 1fr;
    }

    .preview-summary {
        min-height: 92px;
    }

    .preview-item {
        padding: 12px 4px;
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
        margin: 8px 0 0;
    }
}
`;
