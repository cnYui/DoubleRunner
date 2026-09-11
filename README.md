# 跑伴 DoubleRunner

Rokid Glasses 上的跑步步频助手（AIUI 0.17.0，单绿显示）。戴着眼镜跑步时，页面用眼镜的陀螺仪画出最近 6 秒的步态曲线，从曲线里检测每一步和当前步频，并按目标步频（默认 180）播放节拍提示；每次跑步保存为记录，跑完显示整段的步频曲线和达标率。

## 眼镜画布与比例

| 层 | 尺寸 | 来源 |
| --- | --- | --- |
| 光学画布（整个显示区） | 480 × 640 px，3:4 竖屏 | AIUI Studio 1.1.0 真机模拟的 `.device-screen`，与官方光学设计指南一致 |
| AIUI 页面视口（Page 实际渲染区） | 480 × 352 px，15:11 横向 | Studio 效果预览画布（点「进入」后显示 `480 × 352 px`），与 0.17 附带的单绿设计规范的参考画布一致 |
| 安全区 | 左右 16 px、上下 12 px，内容宽 448 px | 设计规范 |
| 对话流内联卡片 | 448 × 150 px | Studio 的 `/debug` 卡片（`onLoad` 时 `wx.getWindowInfo()` 返回 448 × 150） |

页面按 480 × 352 布局：顶部状态行（20 px），曲线框 448 × 152，四个指标（当前步频 44 px 大字、目标步频、节拍实际频率、步数），底部一行操作提示。高度不足 240 px 时（内联卡片）只保留状态、步频、目标和提示。全部颜色只用 `#40ff5e` 的 100 / 72 / 48 / 24 / 12 % 亮度；结构线 1 px，控件圆角 4 px，面板圆角 6 px，大面积填充不超过 12 %。

## 页面

```text
跑伴 · 步频节拍                       [跑步中]  12:34
┌──────────────────────────────────────────────┐
│ GYRO 60Hz · rad/s                       6s  ◉ │  ← 最近 6 秒陀螺仪主轴角速度，检测到的步用实心点和顶部刻度标出
│        ╭╮    ╭╮    ╭╮    ╭╮    ╭╮    ╭╮        │     虚线是自适应阈值，◉ 是节拍圆点（每拍点亮 110 ms）
│  ─────╯╰───╯╰────╯╰───╯╰───╯╰───╯╰───────  │
└──────────────────────────────────────────────┘
176          180            3.0          2180
spm 当前步频   目标步频 · -4 偏慢  节拍 次/秒    步数
单击 暂停 · 前后滑动 调整目标步频
```

| 状态 | 单击 | 向前滑动 | 向后滑动 |
| --- | --- | --- | --- |
| 待命 | 开始跑步 | 目标 +5 | 目标 −5 |
| 跑步中 | 暂停 | 目标 +5（节拍实时改速） | 目标 −5 |
| 已暂停 | 继续 | 目标 +5 | **结束并保存** |
| 已结束（显示整段步频图、平均步频、达标率、用时、步数） | 准备下一次跑步 | — | — |

返回键交给宿主；离开页面时正在跑步会自动暂停，未结束的跑步（有步数）在卸载时静默保存。

## 步频检测

`lib/cadence.js`，纯函数，可在 Node 里回放：

1. 每个轴去掉慢变化基线（一阶高通，τ = 0.8 s）；
2. 取最近方差最大的轴（带 30 % 迟滞，头部俯仰轴通常胜出），带符号使用；
3. 一阶低通平滑（τ = 40 ms）；
4. 局部最大值高于自适应阈值（`max(0.35 rad/s, 0.9 × RMS)`）算一步，但必须在上一步之后信号回到基线以下（"armed"），这样一次点头的两个波瓣只算一步；两步间隔 250～1500 ms；
5. 步频 = 60000 / 最近 8 个步间隔的中位数，再做 35 % 的平滑；2.5 s 没有步则归零。

陀螺仪不可用时用同一算法接加速度计（阈值 1.2 m/s²，重力由高通去掉）。`tests/cadence.test.js` 用 `lib/demo.js` 的合成信号验证：180 / 172 / 110 spm 误差 ≤ 3，噪声不计步，160→184 的变化几秒内跟上，停下后归零。

## 节拍与震动

**AIUI 0.17 / 0.18 没有震动接口**：仓库 `yodaos-project/AIUI` 的文档、示例和 `wx.*` 兼容列表里都没有 vibrate / haptic；Studio 1.1.0 运行时 `navigator.vibrate` 也不存在（页面启动日志 `vibrate=no`）。所以“按 180 步频震动”做不到，节拍改为：

- 声音：`Sound`（0.17 文档里的本地短音效）播放 `assets/tick.wav`（1200 Hz，35 ms），每第 4 拍用 `tick-accent.wav`（1800 Hz，45 ms）；`Sound` 不可用时退到 `AudioContext` 合成音；都没有时只剩画面。
- 画面：曲线框右上角的圆点每拍点亮 110 ms；“节拍 次/秒”显示最近 12 拍的实际频率。

调度用 `lib/metronome.js`：每一拍的时间都从起点 + 序号 × 间隔算出，不从上一次回调累加，所以回调迟到不会累积漂移；180 spm = 每 333 ms 一拍 = 3 次/秒，`tests/metronome.test.js` 在理想时钟上验证了 10 拍/3 秒和迟到不漂移。运行时实际能达到的频率见下面的实测。

## 导入 AIUI Studio

AIUI 工程根是仓库里的 `agent/` 子目录（它直接包含 `app.json`），不是仓库根：

```text
Repository: https://github.com/cnYui/DoubleRunner
Ref: main
AIUI project directory: agent
```

Studio 左上角「新建智能体」→「GitHub 导入」填 `https://github.com/cnYui/DoubleRunner/tree/main/agent`，导入后在项目「···」菜单选「上传云端」，再在对话框发送 `/debug 模拟眼镜设备运行当前页面 pages/run/index`，卡片上点「进入」。同一地址再导入会就地更新。

## Studio 1.1.0 实测（2026-09-11）

- 生命周期：`onTargetChanged(undefined → _current)` → `onLoad`（`wx.getWindowInfo()` = 448 × 150）→ `onShow`；点「进入」后画布移入 480 × 352 的效果预览。
- 镜腿：单击 = `GlobalHook` + `Enter`（页面只执行一次动作）；向前 / 向后滑动 = `GlobalHook` + `ArrowUp` / `ArrowDown`。
- **Web 宿主没有 IMU**：`Gyroscope`、`Accelerometer` 都能构造，`start()` 后立刻收到 `error: Host capability gyroscope.start is not configured on Web host`（加速度计同样）。页面按设计退到演示信号：状态标签带「· 演示」，曲线框标注 `DEMO 演示信号`，通知行写“传感器不可用 · 显示演示信号”。真实的陀螺仪读数只能在眼镜上验证。
- `Sound` 可用（系统日志 `Web audio playback started`），`AudioContext` 不存在，`navigator.vibrate` 不存在，`localStorage` 可用，Canvas 通过 `wx.createCanvasContext` 取得。
- 节拍和演示信号的定时器在 Studio 运行时的实际触发情况：见仓库 `CLAUDE.md` 的实测记录（`diag` 日志每 5 秒一行）。

## 未验证

- 眼镜真机上的陀螺仪读数、步频检测准确度、节拍声音和 3 次/秒的实际稳定性、光学、按键顺序、性能。模拟器结论不等于真机通过。
- 语音路由（“开始跑步”“步频 175”→ `targetCadence`）：草稿态智能体不注册 schema，需要在 Studio 或真机上用语音验证。

## 目录

```text
agent/                     AIUI Studio 导入根（AIUI 0.17.0）
  AGENTS.md                智能体身份、语音路由规则、能力边界
  app.json                 pages: run
  pages/run/index.ink      跑步页（曲线、步频、节拍、记录）
  lib/cadence.js           步频检测（高通 → 主轴 → 低通 → 自适应阈值峰值）
  lib/metronome.js         无漂移节拍调度器
  lib/curve.js             实时曲线与跑后步频图的 Canvas 绘制
  lib/records.js           每秒聚合、记录摘要、localStorage 持久化（最多 20 条）
  lib/demo.js              合成跑步信号（测试与演示模式）
  lib/temple.js            镜腿输入去重
  assets/tick*.wav         节拍音效（tools/make_ticks.py 生成）
  aiui-audit-claims.json   审计声明
tests/                     Node 测试（不进 Studio，也不进安装包）
tools/                     build_audit.py（审计矩阵）、make_ticks.py（音效）
docs/aiui-audit.md         UX / 能力审计矩阵（本机无签名权威，所有层为 BLOCKED）
```

## 开发

```bash
npm test
npm run validate
npm run audit
```

需要 Node 20+ 和 Python 3。`npm test` 的 `tests/page.test.js` 会把 `.ink` 里的 `<script setup>` 当作真实模块加载，用假的 Gyroscope、Sound、localStorage 和 wx 跑完整个状态机；这些假对象只在 `tests/` 里，不会进 Studio 或安装包。
