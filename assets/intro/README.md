一个在本机运行的文档与媒体阅览器。选择自己的文件夹，即可在浏览器中整理、搜索和阅读文件；文档保留在本机，不会上传到云端。

## 快速开始

### 推荐：启动本地服务

1. 双击 `start-local-server.bat`。
2. 等待窗口显示服务地址，并在 Chrome 或 Edge 中打开该地址。默认地址为 `http://127.0.0.1:41731/library.html`；如果端口被占用，服务会自动尝试后续端口，请以窗口显示的地址为准。
3. 点击档案库中的文件夹按钮，选择要载入的文档文件夹。

本地服务只监听本机地址。关闭服务窗口即可停止服务。通过它打开应用，可以使用 TXT 后台分块读取、按路径载入文件夹，以及在资源管理器中定位文件等功能。

### 直接打开

也可以直接打开 `library.html`，然后使用浏览器的文件夹选择器选择文件夹。部分浏览器能力受 `file://` 安全限制；TXT 大文件会改用兼容读取模式，本地服务专属的路径载入和资源管理器定位也不可用。

## 使用方法

1. 选择文件夹后，档案库会按目录展示文件和子文件夹。
2. 使用顶部搜索框查找文件名或文件夹；可按格式筛选、排序，并切换视图。
3. 点击文件卡片开始阅读。收藏、最近浏览和阅读进度会保存在当前浏览器中。
4. 阅读区工具栏可调整字号、行距、字距、主题和阅读模式；拖动档案库与阅读区之间的把手可调整布局。
5. 点击时钟旁的终端按钮，或按 `Ctrl+/` 打开终端。在终端输入 `help` 查看命令，输入 `help 命令名` 查看具体用法。

终端常用命令：

* `open <名称或路径>`：打开文件；媒体文件可加 `--play` 直接播放。`open --recent` 和 `open --favor` 分别进入最近浏览与收藏夹。
* `find <名称或路径>`：搜索文件。
* `ls`、`pwd`、`cd <路径>`：查看目录、当前路径和切换目录。
* `exp load \[绝对路径]`、`exp reload`、`exp exit`：载入、恢复或退出外置文件夹。
* `doc prog <百分比>`、`doc prog --get`：设置或读取当前阅读进度。
* `doc play|pause|next|prior`：控制媒体播放。
* `set palette <sage|ocean|rose|lavender|red|white>`：切换配色；`set theme dark|light` 切换明暗模式。
* `set lang en` 或 `set lang zh-CN`：切换界面语言。书籍内容保持原文。
* `set animation on|off`、`set readermapping on|off`：设置动画和 Markdown 分块渲染。
* `set txtperf on|off`：在终端显示或关闭 TXT 性能指标。

终端快捷键：`Shift+Enter` 输入多行命令；`Ctrl+滚轮` 调整终端字号；`Ctrl+/` 开关终端。

## 支持的文件

* 文本：TXT、Markdown（`.md`、`.markdown`）、LaTeX（`.tex`、`.latex`）
* 文档：EPUB、PDF、Word（`.docx`、`.doc`）
* 图片：PNG、JPG、GIF、WebP、BMP、SVG、AVIF
* 音频：MP3、WAV、OGG、M4A、AAC、FLAC、Opus
* 视频：MP4、WebM、OGV、MOV、M4V

不同格式使用对应的浏览器能力或内置解析器；复杂 LaTeX、旧版 Word 和个别 EPUB 内容可能受格式特性限制。

## 功能与优势

* **本地优先**：文件从用户选择的文件夹读取，不需要账号，也不把内容发送到远程服务器。
* **大 TXT 渐进阅读**：原生 Web Worker 在后台分块读取和解码，界面用虚拟滚动只渲染附近文本块，并通过有界 LRU 缓存减少重复工作。
* **书目管理**：目录浏览、搜索、格式筛选、排序、收藏、最近浏览和阅读进度记录。
* **可调阅读体验**：明暗模式、多种配色、中英文界面、专注模式、字号/行距/字距设置，以及可调整的双栏布局。
* **媒体播放**：内置音视频控制、播放列表和可收起的小播放器；离开媒体阅读页后可继续播放。
* **内置终端**：用易读命令打开文件、查找内容、切换目录、调整阅读设置和控制媒体。
* **本机文件管理**：浏览器文件夹选择适用于一般浏览；本地服务还能按路径载入文件夹并定位文件。

## 技术实现

* 使用原生 HTML、CSS 和 JavaScript 构建，不依赖前端 UI 框架。
* TXT 使用原生 Web Worker、`Blob.slice()`/Range 分块读取、`TextDecoder` 流式解码、原生 DOM 虚拟滚动、`ResizeObserver` 和有界 LRU 缓存；会话 ID 用于隔离旧请求。
* Markdown、LaTeX、EPUB、DOC/DOCX 由本地 JavaScript 解析模块处理；PDF 使用浏览器内置阅读能力，媒体使用 HTML 音视频元素。
* 阅读偏好、收藏、历史和文件夹授权记录保存在浏览器的 LocalStorage/IndexedDB 中。
* 可选的 `local-server.ps1` 仅绑定 `127.0.0.1`，用于本机文件夹访问和静态资源服务，不是云端后端。

## 项目结构

* `library.html`：应用入口与界面结构
* `assets/css/style.css`：布局、主题和阅读样式
* `assets/js/app.js`：界面交互与应用逻辑
* `assets/js/txt-reader.js`、`txt-reader-worker.js`：TXT 分块读取、解码与虚拟阅读
* `assets/js/document-formats.js`、`legacy-doc.js`：文档格式解析
* `assets/tCoLib/`：可用于体验的示例文档
* `start-local-server.bat`、`local-server.ps1`：可选的本机服务

## 开发与验证

需要 Node.js 的开发辅助命令：

```Powershell
node --test tests/txt-reader-worker.test.mjs
node scripts/generate-large-txt.mjs \[输出路径]
```

第二条命令可生成用于性能检查的大型 TXT 文件。应用本身无需安装依赖或执行构建步骤。

如果想修改此 README.MD，运行此命令：

```Powershell
powershell -ExecutionPolicy Bypass -File assets/intro/sync-readme.ps1
```

