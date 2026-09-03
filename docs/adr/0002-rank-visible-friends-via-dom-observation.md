# 名次按可见好友编号，经 DOM 观察感知外部筛选

好友标签组件（bangumi-friend-tag）等页面组件通过切换好友项的内联 `style.display` 实现筛选，不移动 DOM 节点。排序组件此前只在展示顺序变化时重写名次，筛选切换后名次仍是全列表编号，与可见顺序不匹配。我们决定：名次定义为好友在当前排序目标与方向下重排后的**可见好友**序列中的位置（见 CONTEXT.md「可见好友」「名次」），排序栏在每次渲染中按 `orderedFriends` 顺序过滤出可见项连续编号；并通过 `MutationObserver`（`attributeFilter: ["style", "class"]`、`subtree: true`）监听好友列表子树的可见性相关属性变化，回调中用 `checkVisibility()` 重算可见集合、与上次比较，无变化即退出。首次渲染即按当时可见性编号，纯状态提示的渲染顺带幂等修正名次，隐藏项徽章保留旧文本不擦除。

被拒的备选：与 friend-tag 建立自定义事件契约（如 `bangumi-friend-tag:filterchange`）——更显式、开销更低，但要求修改 friend-tag 仓库并引入跨仓库 API 契约，违背「本组件独立兼容任何隐藏型组件」的目标，且 sorter 仍需处理信号不存在的情况；只监听 `style` 属性——今天够用，但与 `checkVisibility()` 的通用判定姿态不一致，换一种隐藏方式即失效；轮询可见性——常驻开销，不可取；由会话层读取可见性传给排序栏——破坏「会话只持领域数据、排序栏持 DOM」的模块边界。

后果：sorter 对外形成了「名次始终匹配可见顺序」的事实承诺，任何组件以 observer 监听范围之外的方式隐藏好友项（如 `hidden` 属性、`content-visibility` 经由非 style/class 途径切换）都不会触发重排；`checkVisibility()` 带来每次筛选切换一遍的样式解析开销，只在可见集合实际变化时才写 DOM。
