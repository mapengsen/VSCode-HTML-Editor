# VSCode HTML Editor

在 VS Code 中并排编辑 HTML 源码和可视化页面。可视化编辑会更新当前文档，保存仍由 VS Code 管理。

## 安装

在扩展视图搜索 **VSCode HTML Editor**，或在 VS Code 快速打开窗口运行 `ext install pengsen.vscode-visual-html-designer`。使用 Remote SSH 时，在已连接的窗口选择将扩展安装到远程主机。

### 使用 VSIX 安装到 Remote SSH 服务器

1. 在 VS Code 连接 Remote SSH 主机，打开服务器上的项目目录。
2. 在已连接的远程窗口打开扩展视图，选择 **Views and More Actions → Install from VSIX...**，选中发布包。确认扩展出现在 **SSH: 主机名** 下。
3. 如果使用服务器终端安装，可先把 VSIX 上传至服务器，再在 VS Code 远程集成终端运行 `code --install-extension ./pengsen.vscode-visual-html-designer-0.1.2.vsix`。

扩展进程在工作区所在的主机运行，可视化界面由桌面 VS Code 显示。打印时通过 VS Code 的端口转发打开浏览器。

## 使用

- 打开 HTML 文件，点击编辑器右上角的预览按钮，或执行 **HTML Editor: Open Design View**。设计视图默认最大化。
- 点击画布即可编辑。工具栏支持段落样式、字体、字号、文本格式、对齐、列表、颜色、插入链接、图片、媒体、表格和符号。
- 底栏的 **HTML** 打开正文 HTML 编辑框，**Full screen** 切换最大化和并排布局，**Print / PDF** 打开浏览器的打印对话框。
- `htmlDesign.syncDelay` 可以调整可视化修改写回源码的延时，默认 300 毫秒。
- 静态页面会加载文档头部的样式以及相对路径资源。画布与打印视图禁用页面自身的脚本。
- 源码在可视编辑尚未同步时被修改，设计视图会保留草稿。可以复制草稿，再重新加载最新源码。

## 开发

在此目录运行 `npm ci`。在 VS Code 中打开此目录并按 F5 启动扩展开发宿主。运行 `npm test` 执行测试，运行 `npm run package` 生成 VSIX。

