## 简介

本项目是由h5构建的静态web应用。一个纯前端、零依赖、可离线打开的文档库 ，没有后端，文件全部在浏览器本地读取。

## 使用

1. 打开 `library.html`。
2. 点击“选择新的文件夹”，您可以选择 `tCoLib`，其中提供了一些预览文档，位于`assets/tCoLib` 。您也可以使用自己的文档。
3. 您可以在目录中查看TXT、Markdown、LaTeX、EPUB、PDF、Word 与媒体等文件。

文件在本地读取，不会上传到服务器。建议使用最新版 Chrome 或 Edge。

## 项目结构

* `library.html`：主体框架
* `assets/css/style.css`：布局与样式
* `assets/js/app.js`：主体业务逻辑
* `tCoLib/`：预览文件夹，可在`assets/`中选择此文件夹
* `assets/js/document-formats.js`：自研轻量 LaTeX 编译器与自研 EPUB(ZIP+OPF)、MD 解析
* `legacy-doc.js`：自研 OLE2/CFB 解析，用于读取旧版 `.doc`

## 修改本说明

如果您想修改此 `README.md` ，请在修改并保存本文件后，在项目根目录运行以下命令，将内容同步到 `assets/js/app.js` 的内嵌副本：

```
powershell -ExecutionPolicy Bypass -File assets/intro/sync-readme.ps1
```

同步后重新打开网页即可看到更新内容。

## 归属权说明

文章或媒体的著作权属于原作者。此实例由 `Cloveralc` 构建，仅归档与查看文件。实例构建中有AI的参与（Codex 6 Luna）。

