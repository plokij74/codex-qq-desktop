# E1 测试稳定性与不稳定用例跟踪日志

更新时间：2026-10-15
所属阶段：E1（基础断点修复与虚假展示止血）

---

## 1. 跟踪背景与原则

按照 Phase E 规划原则（G43），严禁通过放宽断言、删除校验或掩盖底层错误来假装测试全绿。全量测试中的偶发失败必须真实保留现场、分析机理并明确归属阶段闭环。

---

## 2. 不稳定用例档案：`PR_UPDATE_TREE_MISMATCH`

### 2.1 故障特征
- **测试文件**：`tests/remote-ci-delivery.test.js`
- **用例名称**：`D14 PR update recovery retains base head and re-verifies commit`
- **错误代码**：`PR_UPDATE_TREE_MISMATCH`
- **错误信息**：`提交 parent/tree 不一致` 或 `已保存的 PR update commit 无法验证`
- **代码位置**：`src/ai/worktree.js:1535-1575`

### 2.2 触发条件分析
1. **全量并发触发**：在执行默认的 `npm test`（Node.js test runner 多工作线程并发运行 120+ 个测试文件，总计 1060+ 用例）时，出现该偶发失败。
2. **单例独立运行通过**：执行 `node --test tests/remote-ci-delivery.test.js` 或 `--test-concurrency=1` 时，所有用例 100% 稳定通过。
3. **根本原因**：
   - 测试中的模拟 Git 临时仓库在短时间内高频执行 `git commit-tree`、`git update-ref` 和 worktree 清理操作；
   - 在高并发进程争用 CPU/磁盘 I/O 时，Windows 文件句柄延迟释放可能导致父提交与当前预期树哈希在瞬间未能完全刷新至索引；
   - `src/ai/worktree.js` 的树匹配安全门禁（tree match guard）正确触发了防御，拒绝提交不一致的变更。

### 2.3 处置策略与归属
- **绝对不放宽断言**：保留 `PR_UPDATE_TREE_MISMATCH` 的严格校验，确保在真实环境下不一致的提交被绝对阻止。
- **阶段归属**：交由 **E19（Remote CI、Watch 与 PR 审查隔离闭环）** 统一增加测试文件目录级防碰撞随机前缀（UUID temp dir）与 Windows 文件句柄异步回收隔离，彻底解决高并发下的偶发 I/O 锁竞争。

---

## 3. E1 阶段验证状态

| 测试套件 | 测试数量 | 运行结果 | 覆盖缺陷 |
| :--- | :--- | :--- | :--- |
| `tests/e1-direct-defects.test.js` | 8 | 8 通过 / 0 失败 | G01 (OAuth + Prompts), G02 (Max turns 0, Empty projects, Corrupted storage), G03 (Task creation & run) |
| `tests/e1-plan-approval-gap.test.js` | 3 | 3 通过 / 0 失败 | G04 (Plan 审批失效基线，等待 E2 统一持久化) |
| `tests/e1-false-display-stop.test.js` | 5 | 5 通过 / 0 失败 | G09 (插件假开启、站点假健康、好友假在线、附件假解析、预置数据模板化) |
| 关联回归套件（settings, mcp, dialogs） | 41 | 41 通过 / 0 失败 | 无回退 |
