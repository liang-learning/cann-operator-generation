你是 Ascend C 直调工程生成器。不要解释，不要提问，只输出文件块。

目标：生成一个**可编译**的完整工程到 `ops/exp_case1_remote/`。

关键新增硬约束：

1. **绝对不要定义、别名化、typedef、using 任何 `GM_ADDR`**
2. **直接使用 CANN 已提供的 `GM_ADDR`**
3. 不要写：
   - `using GM_ADDR = ...`
   - `typedef ... GM_ADDR`
   - `#define GM_ADDR ...`

上一版远端答案的真实编译失败和必须修复点：

1. 真实报错：
   - `error: expected unqualified-id`
   - 触发行：`using GM_ADDR = __gm__ void*;`
   - 结论：绝对不能自己定义 `GM_ADDR`
2. 真实报错：
   - `error: no matching function for call to 'min'`
   - 触发行：`std::min(...)` 出现在 `__aicore__` 的 `Process`
   - 结论：`__aicore__` 代码里不要用 `std::min`，改用三目表达式
3. 真实报错：
   - `error: no matching function for call to 'Muls'`
   - 触发行：`float alpha = tiling.alpha; float beta = tiling.beta;`
   - 结论：`Muls/Adds` 的标量必须是 `half`，不能是 `float`

新增硬约束：

1. 不要写 `using namespace AscendC;`
2. `__aicore__` 代码里不要调用 `std::min` / `std::max`
3. `alpha` 和 `beta` 必须是类成员：
   - `half alpha = (half)1.0f;`
   - `half beta = (half)0.0f;`
   - 并在 `Init` 中执行：
     - `alpha = (half)tiling.alpha;`
     - `beta = (half)tiling.beta;`
4. `CopyTiling` 不允许申请 `LocalTensor`
5. `CopyTiling` 不允许对 tiling struct 使用 `DataCopyPad`
6. `CopyTiling` 必须直接从 `GM_ADDR tilingGm` 转成 `const __gm__ ExpCase1RemoteTilingData *` 后逐字段拷贝
7. `RunKernel` 不允许使用 `goto`
8. 输出前必须自行检查：生成结果中不能出现以下任何文本：
   - `using GM_ADDR`
   - `typedef` 后接 `GM_ADDR`
   - `#define GM_ADDR`
   - `using namespace AscendC`
   - `std::min(`
   - `std::max(`
   - `float alpha = tiling.alpha`
   - `float beta = tiling.beta`
   - `goto `

其余要求与上一版一致：

- 算子：Exp
- 公式：`y = e^((x * scale + shift) * ln(base))`
- `argv[1]` input path, dtype=`float16`, shape=`[11,13,7,3,29]`
- `argv[2]` output path, dtype=`float16`, same shape
- `argv[3]` base=`2.0`
- `argv[4]` scale=`1.0`
- `argv[5]` shift=`0.0`
- 总元素数：`87087`

环境：

- CANN 8.5.0
- x86_64 Linux
- `bisheng` 可用
- 目标架构：`dav-2201`
- `python3` 可用，但没有 numpy
- `npu-smi` 可能不存在

硬约束：

1. 只使用 `DataCopyPad`、`Muls`、`Adds`、`Exp`
2. Host 侧计算 tiling，Kernel 不动态算 tiling
3. Host 侧顺序：
   - `aclInit`
   - `aclrtSetDevice`
   - `aclrtGetDeviceInfo(deviceId, ACL_DEV_ATTR_VECTOR_CORE_NUM, &availableCoreNum)`
   - `aclrtCreateContext`
   - `aclrtCreateStream`
   - malloc/memcpy
   - `kernel<<<usedCoreNum, nullptr, stream>>>`
   - sync
   - memcpy back
   - destroy/reset/finalize
4. `base == -1.0` 表示自然底数 e；`base <= 0 && base != -1.0` 报错
5. 所有 GM↔UB 搬运必须用 `DataCopyPad`
6. 不能写死核数
7. 余数均匀分配给前 `extraElements` 个核
8. 直接使用 `half`，不要定义 `float16_t`
9. 不能出现草稿、重复实现、重复函数、解释文本
10. 只能有一个 `RunKernel` 和一个 `main`
11. 不要使用 `goto`
12. Host 侧 kernel launch 必须把 `void*` 转成 `reinterpret_cast<uint8_t*>`
13. 不要使用 `memcpy` 复制 tiling
14. Host 侧 tiling staging buffer 必须使用强类型指针
15. `Init` 签名必须是：
    - `__aicore__ inline void Init(GM_ADDR input, GM_ADDR output, const ExpCase1RemoteTilingData &tilingData);`
16. `CopyTiling` 签名必须是：
    - `__aicore__ inline void CopyTiling(ExpCase1RemoteTilingData &localTiling, GM_ADDR tilingGm);`
17. kernel 入口必须先 `AscendC::InitSocState();`
18. kernel 入口中先调用 `CopyTiling(localTiling, tiling)`，再 `op.Init(input, output, localTiling)`

`.asc` 文件头部 include 必须严格是：

```cpp
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>

#include "acl/acl.h"
#include "data_utils.h"
#include "exp_case1_remote_common.h"
#include "kernel_operator.h"
```

`exp_case1_remote_common.h` 必须定义：

```cpp
struct ExpCase1RemoteTilingData {
    uint32_t totalElements;
    uint32_t usedCoreNum;
    uint32_t baseElementsPerCore;
    uint32_t extraElements;
    uint32_t maxTileElements;
    uint32_t alignedTileElements;
    float alpha;
    float beta;
};
```

并提供：

- `AlignUp`
- `ResolveLogBase`
- `ChooseCoreNum`
- `ComputeTiling(uint32_t totalElements, float base, float scale, float shift, int64_t availableCoreNum)`  
  返回 `ExpCase1RemoteTilingData`

`data_utils.h` 只实现：

```cpp
bool ReadFile(const std::string &filePath, size_t &fileSize, void *buffer, size_t bufferSize);
bool WriteFile(const std::string &filePath, const void *buffer, size_t size);
```

`exp_case1_remote.asc` 必须包含：

1. `KernelExpCase1Remote` 类
2. `Init`
3. `Process`
4. `CopyIn`
5. `Compute`
6. `CopyOut`
7. `CopyTiling`
8. 一个且仅一个 kernel 入口：

```cpp
__global__ __vector__ void exp_case1_remote_kernel(GM_ADDR input, GM_ADDR output, GM_ADDR tiling)
```

9. 一个且仅一个：

```cpp
int32_t RunKernel(const std::string& inputPath, const std::string& outputPath,
                  const ExpCase1RemoteTilingData& tiling, aclrtStream stream)
```

10. 一个且仅一个：

```cpp
int main(int argc, char* argv[])
```

`Init` 必须采用这个结构模式：

```cpp
__aicore__ inline void Init(GM_ADDR input, GM_ADDR output, const ExpCase1RemoteTilingData &tilingData)
{
    tiling = tilingData;
    active = true;

    const uint32_t blockIdx = AscendC::GetBlockIdx();
    if (blockIdx >= tiling.usedCoreNum) {
        active = false;
        return;
    }

    elementsThisCore = tiling.baseElementsPerCore + (blockIdx < tiling.extraElements ? 1U : 0U);
    startOffset =
        blockIdx * tiling.baseElementsPerCore + (blockIdx < tiling.extraElements ? blockIdx : tiling.extraElements);

    inputGm.SetGlobalBuffer((__gm__ half *)input + startOffset, elementsThisCore);
    outputGm.SetGlobalBuffer((__gm__ half *)output + startOffset, elementsThisCore);

    pipe.InitBuffer(inQueueX, BUFFER_NUM, tiling.alignedTileElements * sizeof(half));
    pipe.InitBuffer(outQueueY, BUFFER_NUM, tiling.alignedTileElements * sizeof(half));

    alpha = (half)tiling.alpha;
    beta = (half)tiling.beta;
}
```

`CopyTiling` 必须采用这个结构模式：

```cpp
__aicore__ inline void CopyTiling(ExpCase1RemoteTilingData &localTiling, GM_ADDR tilingGm)
{
    const __gm__ ExpCase1RemoteTilingData *globalTiling =
        reinterpret_cast<__gm__ ExpCase1RemoteTilingData *>(tilingGm);
    localTiling.totalElements = globalTiling->totalElements;
    localTiling.usedCoreNum = globalTiling->usedCoreNum;
    localTiling.baseElementsPerCore = globalTiling->baseElementsPerCore;
    localTiling.extraElements = globalTiling->extraElements;
    localTiling.maxTileElements = globalTiling->maxTileElements;
    localTiling.alignedTileElements = globalTiling->alignedTileElements;
    localTiling.alpha = globalTiling->alpha;
    localTiling.beta = globalTiling->beta;
}
```

`Process` 中 tile 大小必须采用这个结构模式，不允许 `std::min`：

```cpp
const uint32_t remaining = elementsThisCore - tileOffset;
const uint32_t tileElements = remaining < tiling.maxTileElements ? remaining : tiling.maxTileElements;
```

kernel 入口必须采用这个结构模式：

```cpp
__global__ __vector__ void exp_case1_remote_kernel(GM_ADDR input, GM_ADDR output, GM_ADDR tiling)
{
    AscendC::InitSocState();
    ExpCase1RemoteTilingData localTiling {};
    CopyTiling(localTiling, tiling);
    KernelExpCase1Remote op;
    op.Init(input, output, localTiling);
    op.Process();
}
```

Kernel launch 必须写成：

```cpp
exp_case1_remote_kernel<<<tiling.usedCoreNum, nullptr, stream>>>(
    reinterpret_cast<uint8_t *>(inputDevice),
    reinterpret_cast<uint8_t *>(outputDevice),
    reinterpret_cast<uint8_t *>(tilingDevice));
```

Host 侧 tiling buffer 必须用：

```cpp
ExpCase1RemoteTilingData *tilingHost = nullptr;
aclrtMallocHost(reinterpret_cast<void **>(&tilingHost), sizeof(ExpCase1RemoteTilingData));
*tilingHost = tiling;
```

Kernel 计算必须写成：

```cpp
AscendC::Muls(outputLocal, inputLocal, alpha, tileElements);
AscendC::Adds(outputLocal, outputLocal, beta, tileElements);
AscendC::Exp<half, 15, false>(outputLocal, outputLocal, tileElements);
```

CopyIn / CopyOut 必须使用：

```cpp
AscendC::DataCopyExtParams copyParams{1, static_cast<uint32_t>(tileElements * sizeof(half)), 0, 0, 0};
AscendC::DataCopyPadExtParams<half> padParams{false, 0, 0, (half)0.0f};
AscendC::DataCopyPad(inputLocal, inputGm[tileOffset], copyParams, padParams);
AscendC::DataCopyPad(outputGm[tileOffset], outputLocal, copyParams);
```

`CMakeLists.txt` 必须是：

```cmake
cmake_minimum_required(VERSION 3.16)
find_package(ASC REQUIRED)
project(exp_case1_remote LANGUAGES ASC CXX)
add_executable(exp_case1_remote exp_case1_remote.asc)
target_link_libraries(exp_case1_remote PRIVATE tiling_api register platform m dl)
target_compile_options(exp_case1_remote PRIVATE
    $<$<COMPILE_LANGUAGE:ASC>:--npu-arch=dav-2201>
)
```

`run.sh` 必须：

```bash
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
SET_ENV_PATH="${ASCEND_TOOLKIT_SET_ENV:-/opt/miniconda3/Ascend/cann-8.5.0/set_env.sh}"
set -euo pipefail
set +u
source "${SET_ENV_PATH}"
set -u
cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}"
cmake --build "${BUILD_DIR}" -j
```

然后生成输入和 golden；无 `npu-smi` 时打印提示并 `exit 0`。

必须生成的文件：

1. `ops/exp_case1_remote/README.md`
2. `ops/exp_case1_remote/CMakeLists.txt`
3. `ops/exp_case1_remote/exp_case1_remote.asc`
4. `ops/exp_case1_remote/exp_case1_remote_common.h`
5. `ops/exp_case1_remote/data_utils.h`
6. `ops/exp_case1_remote/gen_golden.py`
7. `ops/exp_case1_remote/run.sh`

输出格式只能是：

[FILE_BEGIN] ops/exp_case1_remote/CMakeLists.txt
<完整文件内容>
[FILE_END]

不要输出任何文件块之外的文字。不要使用三反引号包裹文件内容。
