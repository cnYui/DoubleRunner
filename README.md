# 跑伴 DoubleRunner

Rokid Glasses 上的跑步步频助手（AIUI 0.17.0，单绿显示）。戴着眼镜跑步时，页面用眼镜的陀螺仪画出最近 6 秒的步态曲线，从曲线里检测每一步和当前步频，并按目标步频（默认 180）播放节拍提示；每次跑步保存为记录。

## 导入 AIUI Studio

AIUI 工程根是仓库里的 `agent/` 子目录（它直接包含 `app.json`），不是仓库根：

```text
Repository: https://github.com/cnYui/DoubleRunner
Ref: main
AIUI project directory: agent
```

Studio 左上角「新建智能体」→「GitHub 导入」填 `https://github.com/cnYui/DoubleRunner/tree/main/agent`，导入后在项目「···」菜单选「上传云端」，再在对话框发送 `/debug 模拟眼镜设备运行当前页面 pages/run/index`，卡片上点「进入」。同一地址再导入会就地更新。

## 目录

```text
agent/                     AIUI Studio 导入根（AIUI 0.17.0）
  AGENTS.md                智能体身份、语音路由规则、能力边界
  app.json                 pages: run
  pages/run/index.ink      跑步页（曲线、步频、节拍、记录）
  lib/cadence.js           步频检测（高通 → 主轴 → 低通 → 自适应阈值峰值）
  lib/metronome.js         无漂移节拍调度器
  lib/curve.js             实时曲线与跑后步频图的 Canvas 绘制
  lib/records.js           每秒聚合、记录摘要、localStorage 持久化
  lib/demo.js              合成跑步信号（测试与演示模式）
  lib/temple.js            镜腿输入去重
  assets/tick*.wav         节拍音效（tools/make_ticks.py 生成）
  aiui-audit-claims.json   审计声明
tests/                     Node 测试（不进 Studio，也不进安装包）
tools/                     build_audit.py（审计矩阵）、make_ticks.py（音效）
docs/aiui-audit.md         UX / 能力审计矩阵
```

## 开发

```bash
npm test
npm run validate
npm run audit
```

需要 Node 20+ 和 Python 3。
