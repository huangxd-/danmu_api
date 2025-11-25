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
    }

    .header h1 {
        font-size: 18px;
    }

    .version-info {
        font-size: 11px;
        flex-wrap: wrap;
    }

    .nav-buttons {
        width: 100%;
    }

    .nav-btn {
        flex: 1;
        text-align: center;
        font-size: 12px;
        padding: 8px 10px;
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
}
`;