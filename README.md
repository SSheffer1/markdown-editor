# Markdown Editor

A fast, offline Markdown editor with live preview that runs in the browser. It's plain HTML, CSS and JavaScript, with no build step, no server and no network requests. Every dependency is vendored in `vendor/`.

## Getting started

Open `index.html` in a browser. That's all.

To get the best file support (saving straight back to files on disk), use a Chromium-based browser such as Chrome or Edge, and serve the folder over `http://localhost`:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

Other browsers can still do everything else. There, **Open** falls back to a normal file picker and **Save** downloads a `.md` file.

## Features

### Editing
- CodeMirror editor with Markdown/GFM syntax highlighting and highlighting inside fenced code blocks (JS, CSS, HTML/XML, Python, shell, C-like languages, YAML)
- Formatting toolbar and shortcuts for bold, italic, strikethrough, headings, lists, task lists, quotes, links, images, code and tables
- Lists continue when you press Enter, brackets close automatically, and you can move or duplicate lines
- **Insert** menu: horizontal rule, footnote, inline or block math, Mermaid diagram, collapsible `<details>` section, table of contents, today's date, front matter
- Table formatter (`Ctrl+Alt+T`) that lines up columns and respects alignment
- Find and replace with match-case, whole-word and regex options
- LaTeX math toolbar with a symbol palette that appears while the cursor is inside math
- Focus mode and typewriter scrolling

### Preview
- Live GitHub-flavored Markdown rendering via [marked](https://marked.js.org/), sanitized with [DOMPurify](https://github.com/cure53/DOMPurify)
- Syntax highlighting via [highlight.js](https://highlightjs.org/)
- Math via [KaTeX](https://katex.org/) (`$…$`, `$$…$$`, or ```` ```math ```` blocks)
- Diagrams via [Mermaid](https://mermaid.js.org/), loaded only when a document uses one
- Extras: `==highlight==`, footnotes, `[TOC]`, YAML front matter shown as a table, and sanitized raw HTML
- Task-list checkboxes you can click in the preview, which update the source
- Synced scrolling between panes; double-clicking the preview jumps to that spot in the source

### Documents and files
- Multiple documents, saved automatically to the browser's IndexedDB, with a searchable **Documents** sidebar and a heading **Outline**
- Open and save real `.md` files using the File System Access API. If an open file changes on disk, it is reloaded.
- Drag and drop a `.md` file to open it. Drop or paste an image to embed it.
- Export standalone HTML, copy the rendered HTML, or download the `.md` file

### Views and appearance
- **Edit**, **Split** and **Preview** modes with a pane divider you can resize
- Themes: System, Light, Dark, Sepia
- Preview styles: GitHub, Book (serif), Academic
- Settings for fonts, font sizes, preview width, tab size, line numbers, wrapping, spell check and more

## Keyboard shortcuts

Press **F1** in the app to see the full list. The most common ones:

| Action | Shortcut |
|---|---|
| New document | `Ctrl+Alt+N` |
| Open / Save / Save as | `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` |
| Edit / Split / Preview | `Ctrl+Alt+1` / `2` / `3` |
| Toggle sidebar | `Ctrl+\` |
| Focus mode | `Ctrl+Shift+F` |
| Find / Replace | `Ctrl+F` / `Ctrl+H` |
| Bold / Italic / Strikethrough | `Ctrl+B` / `Ctrl+I` / `Ctrl+Shift+X` |
| Link / Inline code / Code block | `Ctrl+K` / ``Ctrl+` `` / `Ctrl+Alt+C` |
| Cycle heading level | `Ctrl+Shift+H` |
| Toggle task checkbox | `Ctrl+Shift+L` |
| Format table | `Ctrl+Alt+T` |
| Move line / Duplicate line | `Alt+↑/↓` / `Ctrl+D` |

## Project structure

```
index.html   App markup, dialogs, and the welcome document
app.css      All styles, including themes and preview styles
app.js       Application logic (editor, rendering, storage, files)
vendor/      Third-party libraries (CodeMirror 5, marked, DOMPurify,
             highlight.js, KaTeX + fonts, Mermaid)
```

## Data and privacy

Documents and settings stay in your browser (IndexedDB and `localStorage`). Nothing is uploaded. If you clear site data for the page, documents you haven't saved to files are lost. Deleting a document in the app never deletes its file on disk.

## Third-party libraries

The libraries in `vendor/` are used under their own licenses: CodeMirror (MIT), marked (MIT), DOMPurify (Apache-2.0 / MPL-2.0), highlight.js (BSD-3-Clause), KaTeX (MIT) and Mermaid (MIT).
