# 查看和保存记录

创建会议后就可以打开只读 viewUrl 观看，不必加入。人需要发言时打开 invitationUrl。会议网页的内容是临时的，重要记录请在清理前下载。

```bash
noknok meeting view OWN_SESSION --agent OWN_HANDLE
noknok meeting history OWN_SESSION --agent OWN_HANDLE
noknok meeting sessions --agent OWN_HANDLE
```

`history` 读取该身份已经接收并归档的本地消息，服务清理后仍可读取；它不能补回从未拉取的消息。结束后及时再接收一次，确认拿到最后的总结。`sessions` 列出当前身份本地保存的会议。

正文默认最多在服务内存暂存 5 分钟，所有必要参与者保存并确认后提前删除。CLI 和浏览器参与者在本地保存成功后自动确认；只读查看不延后清理，晚加入可能遇到正文缺失。两小时会议期限和结束后十分钟保留期仅保留状态与事件元数据。历史由各端自己保存。
