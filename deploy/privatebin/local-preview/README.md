# PrivateBin 本地阅读主题

官方 PrivateBin 2.1.1 完整服务，仅监听 127.0.0.1:4319，不影响线上。

首次启动前，用本地已下载的固定镜像生成链接扩展脚本（全程断网，无依赖下载）：

```powershell
python deploy/privatebin/local-preview/prepare.py
docker compose -f deploy/privatebin/local-preview/compose.yml up -d --no-build --pull never
```

创建页保留官方模板，在创建按钮旁加“阅读页：新版 / 原始”切换。默认新版；分享链接的密钥片段后记录 `&view=reader` 或 `&view=original`，原生密钥解析器支持该后缀，后缀不发往服务器。展示链接、复制链接、浏览器地址和原生二维码使用同一生成 URL。没有后缀的旧链接使用原始阅读页。

新版只提供正文、复制全文、字号调整；纯文本/代码按舒适宽度与行距显示，摘要时间戳分栏。无装饰标题、目录、字数、阅读时长、品牌说明。Markdown 保留官方渲染。正文通过 textContent 创建节点，不插入用户 HTML。到期、阅后即焚确认、密码、附件、讨论与创建成功后的删除链接保留上游行为。阅读页不提供切换原始页面的操作，样式只在创建时选择。

- 创建页：http://localhost:4319/
- 新版示例：http://localhost:4319/?c59e8557c5f19d8b#HF6kuruzLhqkLSadxktgF4f5RG9JVTiivR9sba1i9zDG&view=reader
- 同一内容原始版：将末尾改为 &view=original。
- 测试数据保存在独立卷 privatebin-local-reader_privatebin-reader-data。
- prepare.py 只在上游链接生成处添加阅读样式后缀；不改加密、解密或提交逻辑。生成文件在忽略目录 .runtime 中。
- CSS/JS/模板统一位于 ../reader/，本地服务为只读挂载。PHP 模板更新后需要重启本地服务刷新 OPcache；更新静态资源时须递增模板缓存版本。

已实际验证：分别创建两种模式的链接并刷新解密；既有 P2 摘要；桌面及 390px 手机排版。此前版本也验证过官方持久化、阅后即焚流程。

停止（保留数据）：

```powershell
docker compose -f deploy/privatebin/local-preview/compose.yml down
```

当前采用 17px 字号、920px 最大宽度、1.55 行高和条目上下 5px 间距；与 Railway 共用阅读资源。
