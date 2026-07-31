'use strict';

(function initMemoryCommands(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CodexMemoryCommands = api;
})(typeof window !== 'undefined' ? window : null, function memoryCommandsFactory() {
  function errorText(error) {
    return error?.message || String(error);
  }

  function deleteResultMessage(result) {
    if (!result || result.ok === false) {
      return '删除失败：' + (result?.error || '未知错误');
    }
    return result.removed ? '已删除该条记忆' : '未找到该 id';
  }

  function listMessage(result) {
    const lines = (result.entries || []).map((entry) => {
      const scope = entry?.scope === 'user' ? '用户' : '项目';
      const rawText = String(entry?.text || '');
      const text = rawText.length > 60 ? rawText.slice(0, 60) + '…' : rawText;
      return `- \`${entry?.id || ''}\` (${scope}) ${text}`;
    });
    const head = `长期记忆：项目级 ${result.counts?.project ?? 0} 条，用户级 ${result.counts?.user ?? 0} 条`
      + (result.skipped ? `（跳过 ${result.skipped} 行损坏数据）` : '');
    return lines.length
      ? head + '\n' + lines.join('\n') + '\n\n删除用 /forget <id>'
      : head + '\n暂无记忆。用 /remember <事实> 添加。';
  }

  function handleMemoryCommand(text, deps = {}) {
    const cmd = String(text || '').trim();
    const session = deps.session;
    const projectPath = deps.projectPath || null;
    const toast = typeof deps.toast === 'function' ? deps.toast : () => {};
    const onMessagesChanged = typeof deps.onMessagesChanged === 'function'
      ? deps.onMessagesChanged
      : () => {};

    const rememberMatch = cmd.match(/^\/remember(?:\s+([\s\S]*))?$/i);
    if (rememberMatch) {
      const memoryText = String(rememberMatch[1] || '').trim();
      if (!memoryText) {
        toast('用法：/remember <要记住的事实>');
        return true;
      }
      Promise.resolve()
        .then(() => deps.addMemory({ projectPath, text: memoryText }))
        .then((result) => {
          if (!result || result.ok === false) {
            toast('记忆失败：' + (result?.error || '未知错误'));
            return;
          }
          toast(result.deduped
            ? '已存在相同记忆'
            : `已记住（${result.scope === 'user' ? '用户级' : '项目级'}）`);
        })
        .catch((error) => toast(errorText(error)));
      return true;
    }

    if (/^\/memory$/i.test(cmd)) {
      Promise.resolve()
        .then(() => deps.listMemory({ projectPath }))
        .then((result) => {
          if (!result || result.ok === false) {
            toast(result?.error || '读取记忆失败');
            return;
          }
          if (!session || !Array.isArray(session.messages)) {
            toast('当前会话不可用');
            return;
          }
          session.messages.push({ role: 'assistant', content: listMessage(result) });
          onMessagesChanged(session);
        })
        .catch((error) => toast(errorText(error)));
      return true;
    }

    const forgetMatch = cmd.match(/^\/forget(?:\s+([\s\S]*))?$/i);
    if (forgetMatch) {
      const id = String(forgetMatch[1] || '').trim();
      if (!id) {
        toast('用法：/forget <id>，id 用 /memory 查看');
        return true;
      }
      Promise.resolve()
        .then(() => deps.deleteMemory({ projectPath, id }))
        .then((result) => toast(deleteResultMessage(result)))
        .catch((error) => toast(errorText(error)));
      return true;
    }

    return false;
  }

  return { handleMemoryCommand, deleteResultMessage };
});
