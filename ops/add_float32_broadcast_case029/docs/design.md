# add_float32_broadcast_case029 设计说明

## 1. 需求摘要

- Kernel 名称：`add_float32_broadcast_case029`
- 源文件名：`add_float32_broadcast_case029.asc`
- 输入：
  - `x1`：`float32`，shape = `[64, 20481]`
  - `x2`：`float32`，shape = `[2, 64, 1]`
- 输出：
  - `z`：`float32`，shape = `[2, 64, 20481]`
- 语义：按标准广播规则执行 `z = x1 + x2`
- 运行方式：Kernel 直调，单 `.asc` 文件内同时包含 kernel、host 调用和 `main`

## 2. 广播展开

- 将 `x1` 视作 `[1, 64, 20481]`
- 将 `x2` 视作 `[2, 64, 1]`
- 输出 `z` 为 `[2, 64, 20481]`
- 输出第 `outRow` 行对应关系：
  - `x1Row = outRow % 64`
  - `x2Scalar = x2[outRow]`
  - `z[outRow, :] = x1[x1Row, :] + x2Scalar`

## 3. 多核与 Tiling

- 算子为纯向量计算，host 侧在 `aclrtSetDevice` 之后调用 `aclrtGetDeviceInfo(..., ACL_DEV_ATTR_VECTOR_CORE_NUM, ...)`
- 实际使用核数：`usedCoreNum = min(128, availableVectorCoreNum)`
- 行切分策略：
  - `rowsPerCore = 128 / usedCoreNum`
  - `rowRemainder = 128 % usedCoreNum`
  - 前 `rowRemainder` 个核各多处理 1 行
- 行内切分策略：
  - 固定 tile 长度 `2048`
  - `20481 = 2048 * 10 + 1`
  - `totalTileCount = 11`
  - `tailTileElementCount = 1`

## 4. Kernel 内部流程

每个输出行按 tile 执行以下流程：

1. `DataCopyPad` 将 `x1` 当前 tile 从 GM 搬到 UB
2. `DataCopyPad` 将当前行对应的 `x2` 标量从 GM 搬到 UB
3. `Duplicate` 将标量扩成一个 tile 长度的向量
4. `Add` 计算 `x1Tile + broadcastScalarTile`
5. `DataCopyPad` 将结果写回 GM

实现上使用 ping-pong 双缓冲，避免在 A2/A3 上退化成完全串行的单缓冲版本。

## 5. 非对齐处理

- `20481 * sizeof(float) = 81924` 字节，行长不是 32B 对齐
- 最后一块 tile 只有 1 个元素
- 因此 GM <-> UB 均统一使用 `DataCopyPad`

## 6. 文件约定

- 输入文件：
  - `input/x1.bin`
  - `input/x2.bin`
- 输出文件：
  - `output/output.bin`
- Golden 文件：
  - `output/golden.bin`

## 7. 当前环境风险

- 当前仓库内有 `asc-devkit` 和示例，但本机 shell 未配置 `ASCEND_HOME_PATH`
- `find_package(ASC REQUIRED)` 仍依赖外部 CANN Toolkit 的 `set_env.sh`
- 因此代码可按规范落地，但本机是否能成功 `cmake .. && make` 和真机运行，取决于外部 CANN/ACL/NPU 环境是否补齐
