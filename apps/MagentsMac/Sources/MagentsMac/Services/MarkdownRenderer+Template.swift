import Foundation

// MARK: - HTML Template

extension MarkdownRenderer {

    func wrapInHTMLTemplate(_ body: String) -> String {
        """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
        :root {
            --text: #1d1d1f;
            --text-secondary: #6e6e73;
            --bg: transparent;
            --code-bg: #1e1e1e;
            --code-text: #d4d4d4;
            --border: #d2d2d7;
            --link: #0066cc;
            --blockquote-border: #d2d2d7;
            --blockquote-bg: rgba(0,0,0,0.03);
            --table-border: #d2d2d7;
            --table-header-bg: rgba(0,0,0,0.04);
            --checkbox-partial: #ff9500;
        }
        @media (prefers-color-scheme: dark) {
            :root {
                --text: #f5f5f7;
                --text-secondary: #a1a1a6;
                --code-bg: #1e1e1e;
                --code-text: #d4d4d4;
                --border: #424245;
                --link: #2997ff;
                --blockquote-border: #424245;
                --blockquote-bg: rgba(255,255,255,0.05);
                --table-border: #424245;
                --table-header-bg: rgba(255,255,255,0.06);
            }
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
            font-size: 15px; line-height: 1.6; color: var(--text);
            background: var(--bg); max-width: 800px;
            margin: 0 auto; padding: 24px 20px;
            -webkit-font-smoothing: antialiased;
        }
        h1, h2, h3, h4, h5, h6 {
            font-family: -apple-system, "SF Pro Display", sans-serif;
            margin: 1.5em 0 0.5em; font-weight: 600;
        }
        h1 { font-size: 28px; } h2 { font-size: 22px; }
        h3 { font-size: 18px; } h4 { font-size: 16px; }
        p { margin: 0.8em 0; }
        a { color: var(--link); text-decoration: none; }
        a:hover { text-decoration: underline; }
        code {
            font-family: "SF Mono", Menlo, monospace; font-size: 13px;
            background: rgba(128,128,128,0.12); padding: 2px 6px;
            border-radius: 4px;
        }
        pre {
            background: var(--code-bg); color: var(--code-text);
            border-radius: 8px; padding: 16px; margin: 1em 0;
            overflow-x: auto;
        }
        pre code {
            background: none; padding: 0; font-size: 13px;
            line-height: 1.5;
        }
        blockquote {
            border-left: 3px solid var(--blockquote-border);
            background: var(--blockquote-bg);
            padding: 8px 16px; margin: 1em 0; border-radius: 0 6px 6px 0;
        }
        blockquote p { margin: 0.3em 0; color: var(--text-secondary); }
        ul, ol { padding-left: 24px; margin: 0.8em 0; }
        li { margin: 0.3em 0; }
        .task-list { list-style: none; padding-left: 4px; }
        .task-item { display: flex; align-items: baseline; gap: 8px; }
        .task-item input[type="checkbox"] {
            width: 16px; height: 16px; accent-color: #34c759;
        }
        .checkbox-partial {
            color: var(--checkbox-partial); font-size: 16px;
            line-height: 1;
        }
        hr {
            border: none; border-top: 1px solid var(--border);
            margin: 2em 0;
        }
        table {
            border-collapse: collapse; width: 100%; margin: 1em 0;
            font-size: 14px;
        }
        th, td {
            border: 1px solid var(--table-border);
            padding: 8px 12px; text-align: left;
        }
        th { background: var(--table-header-bg); font-weight: 600; }
        del { color: var(--text-secondary); }
        strong { font-weight: 600; }
        /* Basic syntax highlighting keywords */
        .language-swift .kw, .language-typescript .kw,
        .language-javascript .kw { color: #c586c0; }
        </style>
        </head>
        <body>
        \(body)
        </body>
        </html>
        """
    }
}

