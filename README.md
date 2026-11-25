# dsh-failure-guard

给 AI 代理的工具调用装一道闸：**同一个调用别反复撞、连续失败到顶就熔断、失败回执写清楚「这是失败，不是结果」。**

三个问题它都能治：

- 模型调同一个工具、同一份参数，一遍又一遍，回的错都一模一样；
- 某个工具挂了，模型还在往里怼，每一步都在烧上下文；
- 工具报错了，模型把报错当结果，接着往下编。

## 它做什么

挂在 DSH 的两个工具事件上，不碰模型、不改提示词里的工具定义：

1. **重复调用拦截**（`tools/pre-execute`）
   按「会话 + 工具名 + 参数指纹」记账。同一个指纹在窗口内超过 `repeatLimit` 次，直接 `deny`，回一句人话说明为什么不会再变好。

2. **熔断器**（`tools/pre-execute` + `tools/post-execute`）
   按「会话 + 工具名」记连续失败数。到 `failThreshold` 次就开路，`cooldownMs` 内一律拒；冷却结束放**一次**试探，成功回闭合，失败继续开路。

3. **失败回执改造**（`tools/post-execute`）
   失败结果的 content 末尾追加一行：这次是失败、错误码是什么、不许拿报错当答案编、以及「再有几次就会被熔断」。

4. **常驻地基话术**（`systemPrompt.context`，可关）
   一条短句进系统提示区：工具报错就是失败；同一个调用最多试两次，第三次换办法或停下来问。

## 配置

写在 bundle 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: failure-guard
      name: 'dsh-failure-guard'
      config:
        failThreshold: 3        # 连续失败几次开熔断
        cooldownMs: 60000       # 开路后冷却多久（毫秒）
        repeatLimit: 3          # 同指纹最多允许几次，超过就拦
        repeatWindowMs: 600000  # 重复记账的滑动窗口（毫秒）
        grounding: true         # 是否注入常驻地基话术
        exempt: ['windows_desktop']  # 不参与记账的工具
```

`exempt` 默认放过 `windows_desktop`——它是「揭示工具」的入口，被熔断会让人整个桌面都动不了。

## 装法

本仓库是 DSH bundle，包体在 `bundle/`。安装指向这个目录即可：

```
插件管理器 install_bundle <本仓库绝对路径>/bundle
```

装好后在「设置 → 插件」里能看到 `dsh-failure-guard`（entryId `include:failure-guard`）。

## 已知边界

- 记账按**会话**隔离，换会话重新开始。
- 只拦「同一个调用反复撞」和「同一工具连续失败」，不判断调用本身有没有意义。
- 熔断状态在内存里，重启清空——不会把你的会话卡死。
- 只对走 `tools/pre-execute` / `tools/post-execute` 的执行生效；绕过工具管线的调用看不到。

## 许可

MIT，见 [LICENSE](LICENSE)。
