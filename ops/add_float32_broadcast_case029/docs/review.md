# add_float32_broadcast_case029 实现自审

## 结论

- 自审结论：实现方案满足本 case 的核心功能和仓库中的直接调用约束
- 当前阻塞：本机缺少 `cmake`，且 shell 未配置 `ASCEND_HOME_PATH`，因此无法在当前环境完成 `cmake .. && make` 与真机运行验收

## 强制项检查

### 1. Tiling / 切分是否在 Host 侧

- 通过
- `main`/host 调用链中计算并传入：
  - `usedCoreNum`
  - `rowsPerCore`
  - `rowRemainder`
  - `totalTileCount`
  - `tailTileElementCount`

### 2. 核数是否动态获取

- 通过
- 在 `aclrtSetDevice` 之后调用 `aclrtGetDeviceInfo(..., ACL_DEV_ATTR_VECTOR_CORE_NUM, ...)`
- 纯向量算子按 Vector Core 数量切分

### 3. Kernel 入参是否逐个传递

- 通过
- kernel 签名未使用结构体封装入参
- 采用 `x1, x2, z, usedCoreNum, rowsPerCore, rowRemainder, totalTileCount, tailTileElementCount` 逐项传参

### 4. GM <-> UB 数据搬运是否处理非对齐

- 通过
- 行长 `20481 * sizeof(float)` 非 32B 对齐
- GM -> UB 与 UB -> GM 均统一使用 `DataCopyPad`

### 5. 广播语义是否正确

- 通过
- 输出行 `outRow` 对应：
  - `x1Row = outRow % 64`
  - `x2Scalar = x2[outRow]`
  - 每个 tile 用 `Duplicate` 将标量扩成向量后再 `Add`

### 6. 多核越界和尾块是否处理

- 通过
- kernel 侧先检查 `blockIdx >= usedCoreNum`
- 行级余数采用“前若干核多 1 行”的分配方式
- 列级尾块用 `tailTileElementCount` 单独处理

## 风险项

- 未经当前机器上的真实编译器和 ACL runtime 编译验证
- 未在当前机器上实际读取 `input/*.bin` 执行并生成 `output/output.bin`
- 未对 `output/golden.bin` 完成真机精度校验
