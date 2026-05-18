# Reading Annotations (Obsidian Plugin)

一个用于 Obsidian 的阅读标注插件，目标是：
- 标注过程不污染原文结构
- 标注可检索、可跳转、可编辑/删除
- 支持阅读模式与编辑模式一致的核心交互

## 主要功能
- 选中文本后显示浮动 `评论` 按钮
- 一键打开评论弹窗，记录标注内容
- 右侧「当前笔记标注」列表管理（编辑、删除、跳转）
- 标注高亮支持 `Markdown ==高亮==` 写回模式
- 删除标注时可同步取消对应高亮（在无复用时）

## 技术实现
- TypeScript + Obsidian API
- Sidecar 作为事实源
- SQLite 作为索引层

## 开发
```bash
npm install
npm run build
npm run dev
```

## 测试
```bash
npm test
npx tsc --noEmit
```

## 安装（开发模式）
1. 构建产物：`main.js`、`manifest.json`、`styles.css`
2. 拷贝到 Vault 插件目录：
   `.obsidian/plugins/reading-annotations/`
3. 在 Obsidian 中启用插件

## License
MIT
