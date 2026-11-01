// 示例插件：消息里出现「摸鱼」就调侃一句
// 能用的东西由 manifest.permissions 决定，这里只申请了 read_context / send_message
module.exports = {
  async onMessage(msg, api) {
    if (!/摸鱼|划水/.test(msg.text)) return;

    // 拿最近上下文（read_context 权限）
    const ctx = api.getContext(10);
    const who = ctx.length ? ctx[ctx.length - 1].from : msg.from;

    // 发一条消息（send_message 权限）
    api.send(`又摸鱼？今天第几次了（${who} 这笔我记下了）`);
  },
};
