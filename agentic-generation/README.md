# Agentic Generation Eval

基于 `opencode` SDK 的 Ascend C 代码生成评测工程。

它用于批量读取 `prompt.txt` 用例，调用 `opencode` 做 agentic 代码生成，在当前目录下创建独立运行工作区，保存日志和会话导出，并统计 `pass@1`、`pass@n` 等指标。

## 功能

- 支持从目录或单个 `prompt.txt` 读取评测用例
- 使用 `@opencode-ai/sdk` 与本地 `opencode` 服务交互
- 自动同步 `cann/skills`、`agents` 和 `asc-devkit`
- 每次运行固定在 `agentic_run/` 下生成代码和会话产物
- 支持可重入运行，自动归档上一轮运行结果
- 支持结构校验、编译校验和 `pass@k` 统计
- 支持导出 `opencode` session JSON，便于后续训练或分析

## 前置依赖

提交和使用前需要满足：

- Node.js 18+
- 本机已安装 `opencode`
- `opencode` 的 provider / model 已经在你的环境里配置完成
- 如果要做真实 Ascend C 编译校验，需要本机具备 Ascend C 工具链

说明：

- 本工程不会替你配置 `opencode` 的模型
- 本工程会自动 clone `https://gitcode.com/cann/skills.git`
- 本工程会自动 clone `https://gitcode.com/cann/asc-devkit.git`

## 建议提交的目录

以下内容建议提交到远程仓库：

```text
agentic-generation/
├── .gitignore
├── README.md
├── package.json
├── package-lock.json
├── eval.config.json
├── prompt.txt
├── cases/
│   └── .gitkeep
├── src/
│   ├── cli.js
│   ├── evaluator.js
│   ├── opencode-runner.js
│   ├── validation.js
│   ├── dependencies.js
│   ├── config.js
│   ├── cases.js
│   ├── metrics.js
│   └── utils.js
```

以下目录是运行产物或缓存，不建议提交：

- `node_modules/`
- `.cache/`
- `agentic_run/`
- `history/`

这些目录已经在 [.gitignore](/workspace/git/github/liang-learning/cann-operator-generation/agentic-generation/.gitignore) 里排除。

## 目录说明

```text
agentic-generation/
├── eval.config.json      # 主配置文件
├── prompt.txt            # 单文件样例用例
├── cases/                # 默认批量用例目录，每个 case 目录下放一个 prompt.txt
├── src/                  # 评测工程源码
├── agentic_run/          # 当前轮真实运行目录
├── history/              # 历史运行归档
└── .cache/               # skills / asc-devkit 本地缓存
```

## 用例格式

默认支持两种输入方式：

1. 单文件模式

```text
prompt.txt
```

2. 目录模式

```text
cases/
├── case_a/prompt.txt
├── case_b/prompt.txt
└── case_c/prompt.txt
```

每个 case 目录中只要求有一个 `prompt.txt`。

## 安装

```bash
cd /workspace/git/github/liang-learning/cann-operator-generation/agentic-generation
npm install
```

清理运行产物和缓存：

```bash
npm run clean
```

## 运行方式

默认按 [eval.config.json](/workspace/git/github/liang-learning/cann-operator-generation/agentic-generation/eval.config.json) 运行：

```bash
npm run eval
```

对当前目录下单个 `prompt.txt` 做一次样例验证：

```bash
npm run test:sample
```

如果你想手动进入目录，直接用 `opencode` 交互调试：

```bash
npm run bootstrap:manual
cd agentic_run
opencode .
```

说明：

- `bootstrap:manual` 会准备好 `AGENTS.md`、`.opencode/skills`、`.opencode/agents` 和 `asc-devkit`
- 最稳妥的启动目录是 `agentic_run/` 根目录
- 这样启动时会直接加载我在评测工程里配置的那套 skills
- 进入后你可以手动粘贴 prompt，观察真实执行效果
- 如果想把手工实验和自动评测隔离，可以要求 agent 把文件写到 `manual_workspace/`

手动指定路径和参数：

```bash
node src/cli.js \
  --config eval.config.json \
  --cases-path ./prompt.txt \
  --attempts 3 \
  --metric-k 1 \
  --metric-k 3
```

可用参数：

- `--config <path>`：配置文件路径
- `--cases-path <path>`：单个 `prompt.txt` 或批量 case 根目录
- `--attempts <n>`：覆盖每个 case 的采样次数
- `--metric-k <n>`：附加计算一个 `pass@k`
- `--run-dir <path>`：覆盖运行目录
- `--history-dir <path>`：覆盖归档目录

## 配置说明

主配置文件是 [eval.config.json](/workspace/git/github/liang-learning/cann-operator-generation/agentic-generation/eval.config.json)。

### 基本项

- `casesPath`
  默认用例路径，支持目录或单个 `prompt.txt`
- `attempts`
  每个 case 运行次数
- `metricKs`
  需要统计的 `pass@k`
- `runDir`
  当前轮运行目录，固定用于 `opencode` 工作区
- `historyDir`
  历史结果归档目录
- `cacheDir`
  依赖仓库缓存目录

### opencode

- `opencode.agent`
  可选，指定使用的 agent
- `opencode.systemPrompt`
  可选，附加系统提示
- `opencode.startupTimeoutSec`
  启动本地 `opencode` server 的超时时间
- `opencode.promptTimeoutSec`
  单次 session 的最长等待时间
- `opencode.stalledTimeoutSec`
  session 长时间没有进展时提前判定为 stalled，并导出 partial session
- `opencode.exportSessionJson`
  是否调用 `opencode export <sessionID>` 导出会话

### dependencies

- `dependencies.skillsRepoUrl`
  `skills` 仓库地址
- `dependencies.skillsRepoDir`
  `skills` 本地缓存目录
- `dependencies.ascDevkitRepoUrl`
  `asc-devkit` 仓库地址
- `dependencies.ascDevkitRepoDir`
  `asc-devkit` 本地缓存目录
- `dependencies.selectedSkills`
  需要安装到 `.opencode/skills` 的 skills 列表
- `dependencies.selectedAgents`
  需要安装到 `.opencode/agents` 的 agents 列表
- `dependencies.installAscDevkit`
  是否安装 `asc-devkit`
- `dependencies.useSymlinkForAscDevkit`
  是否把 `asc-devkit` 以软链接方式挂到运行目录

### compileCheck

- `compileCheck.enabled`
  是否执行编译检查
- `compileCheck.command`
  自定义编译命令，优先级最高
- `compileCheck.cwd`
  编译命令工作目录，支持 `workspace`、`attempt`、`run`
- `compileCheck.timeoutSec`
  编译超时时间
- `compileCheck.autoDetectCmake`
  未提供自定义命令时，是否自动查找 `CMakeLists.txt`
- `compileCheck.buildDirName`
  自动编译时使用的构建目录名

### scoring / history / runtime

- `scoring.passCriterion`
  当前保留字段，默认按 compile 通过定义 pass
- `history.archiveCases`
  是否在 `history/` 中保留每轮 case 目录
- `runtime.maxMessages`
  拉取 session messages 的最大条数

## 输出说明

当前轮运行结果在 `agentic_run/`：

- `cases/<case>/attempt-xx/workspace/`
  当前 attempt 的实际生成工程
- `cases/<case>/attempt-xx/opencode/`
  会话导出、错误信息、assistant 输出
- `cases/<case>/attempt-xx/compile/compile.log`
  编译检查日志
- `results.json`
  当前整轮汇总

历史结果在 `history/runs/<runId>/`：

- 保存配置快照
- 保存环境信息
- 保存每个 case / attempt 的结果
- 保存 `opencode` 导出或 partial 导出

如果启动新一轮运行时发现旧的 `agentic_run/`，工程会先把它移动到：

```text
history/recovered/<timestamp>/
```

## 编译检查规则

编译检查优先级如下：

1. 使用 `compileCheck.command`
2. 自动探测 `CMakeLists.txt` 后执行 `cmake -S/-B` 和 `cmake --build`
3. 如果检测到 `.asc` 但本机缺少 Ascend C 工具链，则标记为 `unverified`

如果你已经有统一构建脚本，可以这样配置：

```json
{
  "compileCheck": {
    "command": "bash /workspace/git/github/liang-learning/cann-operator-generation/scripts/build_operator.sh {workspace} {build_dir}"
  }
}
```

模板变量：

- `{workspace}`
- `{attempt_dir}`
- `{build_dir}`
- `{run_dir}`
- `{project_root}`

## 指标说明

当前汇总结果会输出两类指标：

- `compilePassAt`
  基于编译检查结果统计的 `pass@k`
- `structurePassAt`
  基于结构校验结果统计的 `pass@k`

结构校验当前至少检查：

- 是否存在 `.asc`
- 是否存在 `.h`
- `.asc` 中是否存在 `int main(int argc, char* argv[])`

## 已验证情况

本地已经用当前 [prompt.txt](/workspace/git/github/liang-learning/cann-operator-generation/agentic-generation/prompt.txt) 做过端到端验证，验证到了以下链路：

- `opencode` server 启动
- session 创建
- `skills` / `agents` / `asc-devkit` 安装
- partial session 导出
- `agentic_run` 与 `history/` 归档
- 指标汇总和结果落盘

说明：

- 当前样例中，模型最终没有产出完整的 `.asc/.h/CMakeLists.txt` 工程，因此样例指标仍为失败
- 这属于当前模型输出质量问题，不是评测工程链路问题
