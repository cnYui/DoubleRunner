# 跑伴 DoubleRunner — Rokid AIUI 跑步步频助手（工作区说明）

> 给 Claude 的说明文件。本文件夹是 `cnYui/DoubleRunner` 仓库的根目录；AIUI Studio 的导入根是其中的 `agent/` 子目录。界面、文档用中文；代码注释用英文。

## 目录关系

| 位置 | 是什么 |
|---|---|
| 本文件夹 | Git 仓库根，GitHub：`https://github.com/cnYui/DoubleRunner`（**公开**，`main`） |
| `agent/` | **AIUI Studio 导入根**（直接含 `app.json`），AIUI 0.17.0，一个 Page：`pages/run/index` 跑步页 |
| `agent/lib/` | 纯逻辑：`cadence.js` 步频检测、`metronome.js` 节拍调度、`curve.js` Canvas 绘制、`records.js` 记录与持久化、`demo.js` 合成跑步信号、`temple.js` 镜腿输入去重（来自 doubletraining） |
| `agent/assets/` | `tick.wav`、`tick-accent.wav`，由 `tools/make_ticks.py` 生成，节拍用 `Sound` 播放 |
| `tests/` | Node 测试（`npm test`，Node 20+）；`page.test.js` 把 `.ink` 的 `<script setup>` 当真实模块加载，用假的 Gyroscope / Sound / localStorage / wx 跑完整个状态机 |
| `tools/build_audit.py` | 从 Skill 的能力清单生成 `docs/aiui-audit.md`；每次改完 `agent/` 都要重新生成 |
| `C:\Users\yui\.claude\skills\rokid-aiui-agent` | 已安装的 Skill，校验脚本在 `scripts/` |

## 改代码 → Studio 调试的循环

1. 本地改 `agent/`，跑 `npm test`、`npm run validate`、`npm run audit`（再用 Skill 的 `validate_aiui_audit.py` 校验，预期 Final status=BLOCKED，本机没有签名权威）。
2. `git commit` + `git push origin main`。
3. Studio（`https://aiui.rokid.com`）左上「新建智能体」整个按钮打开下拉 →「GitHub 导入」→ 地址框填 `https://github.com/cnYui/DoubleRunner/tree/main/agent`（用表单整体赋值，别靠键盘清空）→「确认导入」。同一地址再导入会就地更新。
4. 项目行尾「···」（`button.agent-actions-button`）→「上传云端」→ 状态变「已同步」。用鼠标点「···」在内置浏览器里打不开菜单，用 `element.click()` 可以。
5. 对话框先输入 `/debug` 等它变成标签，再输入 `模拟眼镜设备运行当前页面 pages/run/index`，点发送。卡片上「进入」按钮会被浮动的效果预览窗挡住，用 `element.click()` 点它；之后卡片显示「已进入」，页面进入 480 × 352 的效果预览。
6. 日志第一行 `run onLoad … build=<BUILD> … gyro=… sound=… vibrate=…` 说明 Studio 实际跑的是哪个版本、运行时有哪些能力；`diag …` 每 5 秒一行，记录各定时器的实际触发次数。
7. **内置浏览器面板必须处于显示状态**：面板隐藏时 `requestAnimationFrame` 不触发，GitHub 导入会卡在「正在解包归档」，效果预览也停摆。

## Studio 1.1.0 实测（2026-09-11）

- 生命周期：`onTargetChanged(undefined → _current)` → `onLoad`（此时 `wx.getWindowInfo()` 是 448 × 150 的对话卡片）→ `onShow`；点「进入」后画布移入 480 × 352 的效果预览，target 仍是 `_current`。
- 单击 → `GlobalHook` + `Enter`（页面只执行一次动作）；向前 / 向后滑动 → `GlobalHook` + `ArrowUp` / `ArrowDown`。
- **Web 宿主没有 IMU**：`Gyroscope` / `Accelerometer` 构造函数存在，`start()` 后立刻 `error: Host capability gyroscope.start is not configured on Web host`。页面按设计退到演示信号（`DEMO_WHEN_UNAVAILABLE`），状态标签带「· 演示」。真机（Android 宿主）才有真实读数。
- `Sound` 可用：系统日志 `Web audio playback started … from_user_interaction=false`，节拍音效能播。`AudioContext` 不存在（0.17 运行时），`navigator.vibrate` 不存在——**AIUI 没有震动接口**，节拍只能靠声音和画面。
- Canvas 通过 `wx.createCanvasContext('curve', this)` 拿到上下文（`querySelector('#curve').getContext` 拿不到），绘制后要 `flush()`。
- `localStorage` 可用（`storage=yes`）。
- 定时器：详见 README 的实测记录；节拍和演示信号的定时器精度以 `diag` 日志为准。

## 页面状态机（`_phase`）

`idle`（待命，传感器预览曲线）→ 单击 → `running`（计步、节拍）→ 单击 → `paused` → 单击继续 / 向后滑动 → `finished`（保存记录，画整段步频图）→ 单击 → `idle`。`onHide` 时正在跑步会自动暂停并停传感器、节拍、定时器；`onUnload` 时未结束的跑步（有步数）静默保存。向前 / 向后滑动在 `idle` / `running` 里调整目标步频 ±5（120～220），节拍实时改速。
