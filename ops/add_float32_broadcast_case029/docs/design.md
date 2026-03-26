# 算子设计与实施文档

---

## 0. 概述

### 0.0 需求类型判断

**判断结果**：特定用例

- 输入 shape 已明确指定：x1=[64, 20481], x2=[2, 64, 1]
- 输出 shape 已明确指定：z=[2, 64, 20481]
- 数据类型已明确指定：float32

### 0.1 基本信息

| 项目 | 内容 |
|-----|------|
| 算子名称 | add_float32_broadcast_case029 |
| 核函数名 | add_float32_broadcast_case029 |
| 算子类别 | Broadcast |
| 需求类型 | 特定用例（shape固定） |
| 支持数据类型 | float32 |
| 支持服务器 | A2 / A3 (dav-2201) |
| 特殊约束 | 20481 非 32B 对齐（20481 * 4 = 81924B，需 padding 到 81952B） |

### 0.2 算子类别识别

- **类别**：Broadcast 广播类
- **判断依据**：
  - 输入 shape 不同（x1: [64, 20481], x2: [2, 64, 1]）
  - 需按广播规则对齐后进行逐元素加法
  - x1 扩展维度 [2, 64, 20481]（新增 batch 维度，复制 2 次）
  - x2 扩展维度 [2, 64, 20481]（最后一维从 1 复制扩展到 20481）

### 0.3 成熟方案查阅

- **是否查阅成熟方案**：是
- **参考文档**：
  - Add API: `asc-devkit/docs/api/context/Add.md`
  - DataCopyPad API: `asc-devkit/docs/api/context/DataCopyPad(ISASI).md`
  - Arithmetic API 优化: `.opencode/skills/ascendc-api-best-practices/references/api-arithmetic.md`
  - Add 示例: `asc-devkit/examples/01_simd_cpp_api/00_introduction/01_add/basic_api_memory_allocator_add/add.asc`

### 0.4 应用关键设计

| 设计项 | 成熟方案 | 应用到当前算子 |
|--------|---------|----------------|
| 非32B对齐搬运 | DataCopyPad + padding | 20481 * 4B = 81924B，padding 到 81952B |
| 广播优化 | Adds 标量操作 | x2 广播使用 Adds(scalar)，避免 Duplicate |
| 多核切分 | 按行动态分配 | 按 (d0, d1) 组合切分，动态核数 |

---

## 1. 算子设计

### 1.1 数学公式

```
// 输入输出定义
输入: 
  x1 - shape=[64, 20481], dtype=float32
  x2 - shape=[2, 64, 1], dtype=float32

输出:
  z  - shape=[2, 64, 20481], dtype=float32

// 广播规则
x1: [64, 20481] -> 扩展为 [1, 64, 20481] -> 广播到 [2, 64, 20481]
    (batch 维度从 1 复制到 2)
x2: [2, 64, 1] -> 广播到 [2, 64, 20481]
    (最后一维从 1 复制到 20481)

// 数学公式（广播加法）
z[b, i, j] = x1[i, j] + x2[b, i, 0]
// 其中 b ∈ [0, 2), i ∈ [0, 64), j ∈ [0, 20481)
```

### 1.2 API 映射

| 数学操作 | 对应 API | 关键参数 | 数据布局 | 官方文档 |
|---------|---------|---------|---------|---------|
| GM→UB 搬运 x1 | DataCopyPad | blockLen=81924B, isPad=false | ND 连续 | [DataCopyPad](../../../../asc-devkit/docs/api/context/DataCopyPad(ISASI).md) |
| GM→UB 搬运 x2 标量 | DataCopyPad | blockLen=4B | ND 连续 | [DataCopyPad](../../../../asc-devkit/docs/api/context/DataCopyPad(ISASI).md) |
| 广播加法 | Adds | scalarValue | 标量广播 | [api-arithmetic](../../../../.opencode/skills/ascendc-api-best-practices/references/api-arithmetic.md) |
| UB→GM 搬运 z | DataCopyPad | blockLen=81924B | ND 连续 | [DataCopyPad](../../../../asc-devkit/docs/api/context/DataCopyPad(ISASI).md) |

#### 1.2.1 API 语义验证（⚠️ 强制）

| API | 数据布局 | 功能需求 | API选择 | 限制条件 | 匹配 | 文档 |
|-----|---------|---------|---------|---------|-----|------|
| DataCopyPad | GM→UB, 20481 个 float 非对齐 | 搬运 + 自动填充 | `DataCopyPad(dst, src, copyParams, padParams)` | LocalTensor 需 32B 对齐 | ✅ | [链接](../../../../asc-devkit/docs/api/context/DataCopyPad(ISASI).md) |
| Adds | UB, 标量广播到整行 | x1 + scalar | `Adds(dst, src, scalar, count)` | 无 | ✅ | [链接](../../../../.opencode/skills/ascendc-api-best-practices/references/api-arithmetic.md) |

**验证清单**：
- [x] 1. 数据布局确认（ND 连续存储，非对齐）
- [x] 2. 功能需求明确（广播加法：x2 标量广播）
- [x] 3. 已查阅官方文档（DataCopyPad, Adds）
- [x] 4. 匹配验证（DataCopyPad 支持非对齐，Adds 支持标量广播）
- [x] 5. 已记录验证过程

### 1.3 数据流

```
输入 x1 (Global Tensor) [64, 20481]
    ↓ DataCopyPad (非对齐搬运，取对应行)
输入 x1 (Local Tensor) [20481] + padding
    
输入 x2 (Global Tensor) [2, 64, 1]
    ↓ DataCopyPad (搬运单个标量)
输入 x2 (Local Tensor) [1] 标量
    ↓ GetValue 获取标量值
x2 标量值 (scalar)
    ↓ Adds(x1Local, scalar, count=20481)
输出 z (Local Tensor) [20481] + padding
    ↓ DataCopyPad (非对齐写回)
输出 z (Global Tensor) [2, 64, 20481]
```

### 1.4 核心计算步骤

**核心计算步骤**：
```
1. 计算当前核处理的行范围 [startRow, endRow)
2. 对于每行 rowIdx in [startRow, endRow):
   a. 计算 d0 = rowIdx / 64, d1 = rowIdx % 64
   b. 从 x1Gm[d1 * 20481] 搬运 20481 个元素到 x1Local (DataCopyPad)
   c. 从 x2Gm[d0 * 64 + d1] 搬运 1 个标量到 x2Local (DataCopyPad)
   d. 获取 x2 标量值: scalar = x2Local.GetValue(0)
   e. 执行广播加法: Adds(zLocal, x1Local, scalar, 20481)
   f. 从 zLocal 搬运 20481 个元素到 zGm[rowIdx * 20481] (DataCopyPad)
```

**关键设计要点**：
1. **Buffer 使用**: `x1Local`(输入 x1 行数据), `x2Local`(x2 标量), `zLocal`(输出)
2. **广播实现**: x2 的最后一维广播
   - 方案：使用 Adds(scalar) 标量加法，避免 Duplicate 开销
3. **非对齐处理**:
   - blockLen = 20481 * 4 = 81924 字节（非 32B 对齐）
   - DataCopyPad 自动填充到 32B 对齐（81952 字节 = 20488 个 float）
4. **x1 广播**（batch 维度扩展）:
   - d0=0 和 d0=1 使用相同的 x1[d1, :] 数据
   - 通过计算正确的 x1Gm offset 实现（offset = d1 * 20481，与 d0 无关）

**参数使用规则**：
| 参数位置 | 用有效长度 | 用对齐长度 |
|---------|-----------|-----------|
| DataCopyPad blockLen | ✓ (20481 * 4) | ✗ |
| Adds count | ✓ (20481) | ✗ |
| UB Buffer 大小分配 | ✗ | ✓ (20488 * 4 = 81952B) |

### 1.5 内存管理(Buffer 规划)

| Buffer 名称 | 用途 | 大小计算 | TPosition |
|------------|------|---------|-----------|
| x1Local | x1 一行数据 | 20488 * 4 = 81952 B（对齐后） | VECIN |
| x2Local | x2 单个标量 | 8 * 4 = 32 B（最小对齐） | VECIN |
| zLocal | 输出一行数据 | 20488 * 4 = 81952 B（对齐后） | VECOUT |

**对齐计算**:
- 20481 个 FP32 = 81924 字节
- 32 字节对齐后: ceil(81924 / 32) * 32 = 81952 字节 = 20488 个 FP32
- padding 元素数: 20488 - 20481 = 7 个

**总 UB 使用量**: 81952 + 32 + 81952 = 163936 B ≈ 160 KB < 192 KB ✅

---

## 2. 架构设计

### 2.1 多核切分策略

| 项目 | 说明 |
|-----|------|
| 切分维度 | 按输出的 (d0, d1) 组合切分，共 2×64 = 128 行 |
| 单核任务量 | 动态计算：ceil(128 / usedCoreNum) 行 |
| 使用的核数 | 动态获取 `ACL_DEV_ATTR_VECTOR_CORE_NUM` |
| 负载均衡方式 | 按行序号均匀分配，最后一核处理余数 |

**核数计算规范**：

```cpp
// Host 侧（强制）
int64_t availableCoreNum = 8;  // 默认值
aclrtGetDeviceInfo(deviceId, ACL_DEV_ATTR_VECTOR_CORE_NUM, &availableCoreNum);
uint32_t totalRows = 2 * 64;  // 128 行
uint32_t usedCoreNum = (totalRows < availableCoreNum) ? totalRows : (uint32_t)availableCoreNum;

// Tiling 结构体
struct AddBroadcastTilingData {
    uint32_t usedCoreNum;      // 实际使用的核数
    uint32_t totalRows;        // 总行数 = 128
    uint32_t rowsPerCore;      // 每核处理的行数
    uint32_t rowLength;        // 每行有效元素数 = 20481
    uint32_t rowLengthAlign;   // 对齐后元素数 = 20488
};
```

### 2.2 UB 切分策略

| 项目 | 说明 |
|-----|------|
| UB 容量 | 192KB (A2/A3) |
| 单次处理数据量 | 1 行 = 20481 元素（对齐后 20488） |
| 是否需要分 chunk | 否，单行可完整放入 UB |
| 单行 UB 占用 | ~160 KB < 192 KB ✅ |

### 2.3 分支场景覆盖

| 分支条件 | 处理策略 |
|---------|---------|
| 数据类型 | 固定 float32，无分支 |
| 行数 | 固定 128 行，动态核数分配 |
| 非对齐 | DataCopyPad 统一处理 |
| 尾核处理 | 最后一个核处理余数行 |

### 2.4 类别特有设计

**算子类别**: Broadcast

**核心伪代码**:

```cpp
// Tiling 结构体
struct AddBroadcastTilingData {
    uint32_t usedCoreNum;
    uint32_t totalRows;        // 128
    uint32_t rowsPerCore;
    uint32_t rowLength;        // 20481
    uint32_t rowLengthAlign;   // 20488
};

// Kernel 核心计算
__aicore__ inline void Process() {
    uint32_t blockIdx = AscendC::GetBlockIdx();
    if (blockIdx >= tiling.usedCoreNum) return;
    
    // 计算当前核处理的行范围
    uint32_t startRow = blockIdx * tiling.rowsPerCore;
    uint32_t endRow = (blockIdx == tiling.usedCoreNum - 1) 
                      ? tiling.totalRows 
                      : startRow + tiling.rowsPerCore;
    
    // 使用 LocalMemAllocator 分配 Buffer
    AscendC::LocalMemAllocator<AscendC::Hardware::UB> ubAllocator;
    AscendC::LocalTensor<float> x1Local = ubAllocator.Alloc<float, 20488>();
    AscendC::LocalTensor<float> x2Local = ubAllocator.Alloc<float, 8>();
    AscendC::LocalTensor<float> zLocal = ubAllocator.Alloc<float, 20488>();
    
    // 逐行处理
    for (uint32_t rowIdx = startRow; rowIdx < endRow; rowIdx++) {
        // 计算对应的 d0, d1 索引
        uint32_t d0 = rowIdx / 64;  // batch 维度: 0 或 1
        uint32_t d1 = rowIdx % 64;  // 行维度: 0~63
        
        // === Step 1: 从 x1 搬运一行数据 ===
        // x1 shape: [64, 20481], 按 d1 取行
        // 注意: x1 在 batch 维度广播，所以无论 d0=0 还是 d0=1，都用同一个 d1 行
        uint32_t x1Offset = d1 * tiling.rowLength;
        AscendC::DataCopyExtParams copyParams1{1, tiling.rowLength * sizeof(float), 0, 0, 0};
        AscendC::DataCopyPadExtParams<float> padParams1{false, 0, 0, 0};
        AscendC::DataCopyPad(x1Local, x1Gm[x1Offset], copyParams1, padParams1);
        
        // === Step 2: 从 x2 搬运一个标量 ===
        // x2 shape: [2, 64, 1], 按 (d0, d1) 取标量
        uint32_t x2Offset = d0 * 64 + d1;
        AscendC::DataCopyExtParams copyParams2{1, sizeof(float), 0, 0, 0};
        AscendC::DataCopyPadExtParams<float> padParams2{false, 0, 0, 0};
        AscendC::DataCopyPad(x2Local, x2Gm[x2Offset], copyParams2, padParams2);
        
        // === Step 3: 获取 x2 标量值 ===
        float scalar = x2Local.GetValue(0);
        
        // === Step 4: 广播加法 (使用 Adds 实现 x2 标量广播) ===
        AscendC::Adds(zLocal, x1Local, scalar, tiling.rowLength);
        
        // === Step 5: 搬运结果到 GM ===
        // z shape: [2, 64, 20481], 按 rowIdx 写入
        uint32_t zOffset = rowIdx * tiling.rowLength;
        AscendC::DataCopyExtParams copyParamsOut{1, tiling.rowLength * sizeof(float), 0, 0, 0};
        AscendC::DataCopyPad(zGm[zOffset], zLocal, copyParamsOut);
    }
}
```

**Buffer 需求**:

| Buffer 名称 | 用途 | 大小计算 |
|------------|------|---------|
| x1Local | 存储 x1 一行数据 | 20488 * 4 = 81952 B |
| x2Local | 存储 x2 一个标量 | 8 * 4 = 32 B |
| zLocal | 存储输出一行数据 | 20488 * 4 = 81952 B |

**广播策略说明**:
- **x1 广播（batch 维度）**: 通过索引计算实现
  - d0=0 时，x1Offset = d1 * 20481
  - d0=1 时，x1Offset = d1 * 20481（相同）
  - 无需显式数据复制
- **x2 广播（最后一维）**: 通过 Adds 标量操作实现
  - 将 x2 的单个值作为标量加到 x1 的每个元素
  - 比使用 BinaryRepeatParams.src1RepStride=0 更简单高效

---

## 3. NPU 优化

### 3.1 SIMD

- 使用 API：Adds（标量加法，SIMD 并行）
- 数据宽度：每次处理 20481 个 FP32 元素
- 向量化宽度：矢量计算单元并行处理

### 3.2 Tiling 参数计算

| 参数 | 公式 | 说明 |
|------|------|------|
| totalRows | 2 × 64 = 128 | 总行数 |
| rowLength | 20481 | 有效元素数 |
| rowLengthAlign | ceil(20481 / 8) × 8 = 20488 | 32B 对齐后元素数 |
| rowsPerCore | ceil(128 / usedCoreNum) | 每核处理行数 |

### 3.3 双缓冲

- 是否使用：否（推荐使用单缓冲）
- 原因：单行处理模式，Adds 标量操作开销小，双缓冲收益有限
- 单行处理流水线：CopyIn → Compute → CopyOut（行间串行）

### 3.4 流水线

- 流水线阶段：单行内无流水线
- 行间处理：串行执行
- 优化空间：可考虑行级异步流水线，但当前用例规模下非必要

---

## 4. 实施计划

### 4.1 文件清单

#### 通用文件

| 序号 | 文件路径 | 说明 |
|------|---------|------|
| 1 | `ops/add_float32_broadcast_case029/docs/design.md` | 设计与实施文档（本文档） |
| 2 | `ops/add_float32_broadcast_case029/CMakeLists.txt` | 构建脚本 |
| 3 | `ops/add_float32_broadcast_case029/gen_golden.py` | Golden 数据生成脚本 |
| 4 | `ops/add_float32_broadcast_case029/run.sh` | 运行脚本 |

#### Kernel 文件

| 序号 | 文件路径 | 说明 |
|------|---------|------|
| 1 | `ops/add_float32_broadcast_case029/add_float32_broadcast_case029.asc` | Kernel 主入口 + 实现 |

### 4.2 测试计划

#### 功能测试矩阵

| 维度 | 测试值 | 覆盖场景 |
|------|-------|---------|
| x1 shape | [64, 20481] | 非对齐数据 |
| x2 shape | [2, 64, 1] | 广播场景 |
| 输出 shape | [2, 64, 20481] | 广播加法结果 |
| 数据类型 | float32 | 单精度浮点 |

#### 测试用例

| 序号 | x1 | x2 | 说明 |
|------|-----|-----|------|
| 1 | 随机正数 | 随机正数 | 正常计算 |
| 2 | 全 0 | 随机数 | 广播加常数 |
| 3 | 随机数 | 全 0 | 恒等运算 |
| 4 | 大数 | 大数 | 数值稳定性 |
| 5 | 负数范围 | 正数范围 | 负数处理 |

#### 精度验证

- **验证方法**：与 NumPy 广播加法结果逐元素比对
- **精度标准**：rtol=1e-5, atol=1e-5
- **验证项**：所有输出元素

#### 边界测试

| 测试项 | 输入 | 预期输出 |
|--------|------|---------|
| 最大值相加 | FLT_MAX, FLT_MAX | INF 或饱和 |
| 最小值相加 | -FLT_MAX, -FLT_MAX | -INF 或饱和 |
| 零向量 | 全 0, 全 0 | 全 0 |
| NaN 处理 | NaN, 任意 | NaN |

### 4.3 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 非对齐搬运精度问题 | 低 | 中 | 严格使用 DataCopyPad，验证边界元素 |
| 核数动态分配错误 | 低 | 中 | 完善边界处理，最后一核处理余数 |
| 广播逻辑错误 | 低 | 高 | 分步验证索引映射，添加调试 printf |

---

## 5. 确认清单

### 5.1 设计确认

- [x] 多核切分策略已确定（按行切分，动态核数）
- [x] UB 切分策略已确定（单行处理，无需分 chunk）
- [x] Buffer 规划已完成（x1Local, x2Local, zLocal）
- [x] 分支场景已覆盖（非对齐、尾核处理）
- [x] 类别特有设计已完成（广播优化：Adds）

### 5.2 实施确认

- [ ] 文件清单完整
- [ ] 测试计划完整（功能 + 精度 + 边界）
- [ ] 风险识别充分

---

## 6. 参考资源

- 官方示例: `asc-devkit/examples/01_simd_cpp_api/00_introduction/01_add/basic_api_memory_allocator_add/add.asc`
- API 文档:
  - `asc-devkit/docs/api/context/Add.md`
  - `asc-devkit/docs/api/context/DataCopyPad(ISASI).md`
  - `asc-devkit/docs/api/context/BinaryRepeatParams.md`
- 最佳实践:
  - `.opencode/skills/ascendc-api-best-practices/references/api-arithmetic.md`
  - `.opencode/skills/ascendc-api-best-practices/references/api-datacopy.md`
